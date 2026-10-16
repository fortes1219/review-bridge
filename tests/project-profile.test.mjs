import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { detectProject, resolveProfile } from "../installer/project-profile.mjs";

async function profileFixture(t, files) {
  const target = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-profile-"));
  t.after(() => fsp.rm(target, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(target, relative);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.writeFile(absolute, typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n", "utf8");
  }
  return target;
}

test("auto profile registry recognizes common backend and frontend stacks", async (t) => {
  const cases = [
    {
      id: "rust-backend",
      files: { "Cargo.toml": "[package]\nname='fixture'\nversion='0.1.0'\n[dependencies]\ntokio='1'\n" },
      capability: "tokio",
      verification: "cargo test --workspace",
    },
    {
      id: "vue-frontend",
      files: { "package.json": { scripts: { typecheck: "vue-tsc --noEmit" }, dependencies: { vue: "3" }, devDependencies: { typescript: "5" } } },
      capability: "vue",
      verification: "npm run typecheck",
    },
    {
      id: "node-backend",
      files: { "package.json": { scripts: { test: "node --test" }, dependencies: { express: "5" } } },
      capability: "express",
      verification: "npm run test",
    },
    {
      id: "go-backend",
      files: { "go.mod": "module example.invalid/fixture\n\ngo 1.24\n\nrequire github.com/gin-gonic/gin v1.10.0\n" },
      capability: "gin",
      verification: "go test ./...",
    },
    {
      id: "python-backend",
      files: { "pyproject.toml": "[project]\ndependencies = ['fastapi', 'pytest']\n" },
      capability: "fastapi",
      verification: null,
    },
    {
      id: "java-backend",
      files: { "pom.xml": "<project><dependencies><dependency>spring-boot</dependency></dependencies></project>" },
      capability: "spring-boot",
      verification: "mvn test",
    },
    {
      id: "php-laravel",
      files: {
        "artisan": "#!/usr/bin/env php\n",
        "composer.json": { require: { "laravel/framework": "^12" }, scripts: { test: "phpunit" } },
      },
      capability: "laravel",
      verification: "php artisan test",
    },
    {
      id: "dotnet-backend",
      files: { "Fixture.csproj": "<Project Sdk=\"Microsoft.NET.Sdk.Web\"></Project>" },
      capability: null,
      verification: "dotnet test",
    },
  ];

  for (const expected of cases) {
    await t.test(expected.id, async (t) => {
      const target = await profileFixture(t, expected.files);
      const profile = await resolveProfile(target, "auto");
      assert.equal(profile.profile_id, expected.id);
      const detection = await detectProject(target, profile);
      if (expected.capability) assert.equal(detection.capabilities.includes(expected.capability), true);
      if (expected.verification) assert.equal(detection.verification_commands.includes(expected.verification), true);
    });
  }
});

test("auto profile detection fails closed for a mixed-stack repository", async (t) => {
  const target = await profileFixture(t, {
    "Cargo.toml": "[package]\nname='fixture'\nversion='0.1.0'\n",
    "package.json": { dependencies: { vue: "3" } },
  });
  await assert.rejects(resolveProfile(target, "auto"), /ambiguous/i);
});
