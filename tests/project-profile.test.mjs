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

// The frontend frameworks a package.json names, told apart as Storybook tells them apart (storybookjs/storybook
// v8.6.14 code/core/src/cli/project_types.ts: nuxt, next, @angular/core, and react last, since every React
// framework has react) and as antfu/eslint-config takes vue, nuxt, vitepress and @slidev/cli for Vue
// (src/factory.ts:56-61). A folder of each is detected as one type only, or detection would refuse as ambiguous.
const detected = async (t, packageJson, files = {}) => (await resolveProfile(await profileFixture(t, { "package.json": packageJson, ...files }), "auto")).profile_id;

test("a Nuxt project is a Vue frontend, with nuxt in dependencies or in devDependencies", async (t) => {
  assert.equal(await detected(t, { scripts: { test: "vitest run" }, dependencies: { nuxt: "^4" } }), "vue-frontend");
  assert.equal(await detected(t, { scripts: { test: "vitest run" }, devDependencies: { nuxt: "^4" } }), "vue-frontend");
});

test("a VitePress site and a Slidev deck are Vue frontends, not Node backends", async (t) => {
  assert.equal(await detected(t, { devDependencies: { vitepress: "^1" } }), "vue-frontend");
  assert.equal(await detected(t, { dependencies: { "@slidev/cli": "^52" } }), "vue-frontend");
});

test("a React project is a React frontend", async (t) => {
  assert.equal(await detected(t, { dependencies: { react: "^19", "react-dom": "^19" } }), "react-frontend");
});

test("a Next project is a Next frontend, and not a React frontend too", async (t) => {
  assert.equal(await detected(t, { dependencies: { next: "^16", react: "^19", "react-dom": "^19" } }), "next-frontend");
});

test("an Angular project is an Angular frontend, and not a Node backend", async (t) => {
  assert.equal(await detected(t, { dependencies: { "@angular/core": "^21", rxjs: "^7" }, devDependencies: { "@angular/cli": "^21" } }), "angular-frontend");
});

// Which rule runs the tests is decided by the rules a profile writes into bridge.json's test block, read here
// from the profile file itself (selectTest takes the first whose conditions hold, features/workOrder/test.mjs).
// A test run has no terminal, so a runner that watches by default never ends and is killed at its limit:
// react-scripts watches unless CI is set or --watchAll=false is given (facebook/create-react-app
// packages/react-scripts/scripts/test.js:48-57), found by its installed bin as Storybook finds it
// (project_types.ts:183-192); Angular's Karma builder watches by default (angular/angular-cli
// packages/angular/build/src/builders/karma/schema.json:230-234), found by the workspace's angular.json.
const { selectTest } = await import("../review-bridge/features/workOrder/test.mjs");
async function chosenCommand(t, profileId, files) {
  const repoRoot = await profileFixture(t, files);
  const profile = await resolveProfile(repoRoot, profileId);
  const chosen = await selectTest({ repoRoot, bridgeConfig: { test: { profile_id: profile.profile_id, rules: profile.verification_rules } } });
  return chosen.command;
}

test("an Angular workspace runs its tests once with --watch=false, and a project without angular.json runs npm test", async (t) => {
  const packageJson = { scripts: { test: "ng test" }, dependencies: { "@angular/core": "^21" } };
  assert.equal(await chosenCommand(t, "angular-frontend", { "package.json": packageJson, "angular.json": { version: 1, projects: {} } }), "npm test -- --watch=false", "an Angular workspace's tests do not watch");
  assert.equal(await chosenCommand(t, "angular-frontend", { "package.json": packageJson }), "npm test");
});

test("a Create React App project runs its tests once with --watchAll=false, and another React project runs npm test", async (t) => {
  const packageJson = { scripts: { test: "react-scripts test" }, dependencies: { react: "^19", "react-scripts": "5.0.1" } };
  assert.equal(await chosenCommand(t, "react-frontend", { "package.json": packageJson, "node_modules/.bin/react-scripts": "#!/bin/sh\n" }), "npm test -- --watchAll=false", "a Create React App project's tests do not watch");
  assert.equal(await chosenCommand(t, "react-frontend", { "package.json": { scripts: { test: "vitest run" }, dependencies: { react: "^19" } } }), "npm test");
});

test("a Next project runs npm test, and one without a test script has none", async (t) => {
  assert.equal(await chosenCommand(t, "next-frontend", { "package.json": { scripts: { test: "vitest run" }, dependencies: { next: "^16" } } }), "npm test");
  assert.equal(await chosenCommand(t, "next-frontend", { "package.json": { scripts: { dev: "next dev" }, dependencies: { next: "^16" } } }), null);
});
