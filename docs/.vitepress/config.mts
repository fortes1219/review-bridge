import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import type { HeadConfig } from 'vitepress'
import pkg from '../../package.json' with { type: 'json' }

const SITE = 'https://review-bridge.akasa-lab.dev'
const VERSION = (pkg as { version: string }).version
const LOCALES = { root: { prefix: '', lang: 'en', description: 'Review Bridge runs AI coding agents under a sealed contract, a human authorization, a budget the harness holds, and an independent read-only reviewer, and records every step in PostgreSQL.' }, ja: { prefix: 'ja/', lang: 'ja', description: 'Review Bridge は AI コーディングエージェントを、封印された契約、人の承認、ハーネスが管理する予算、独立した読み取り専用レビュアーのもとで実行し、すべての段階を PostgreSQL に記録します。' }, 'zh-TW': { prefix: 'zh-TW/', lang: 'zh-TW', description: 'Review Bridge 讓 AI coding agent 在封存的合約、人的授權、harness 控制的預算、獨立唯讀 reviewer 之下工作，每一步都記進 PostgreSQL。' } } as const

// The page path every locale shares: 'zh-TW/guide/install.md' -> 'guide/install'; 'index.md' -> ''.
function sharedPath(relativePath: string) {
  const noExt = relativePath.replace(/\.md$/, '').replace(/(^|\/)index$/, '$1')
  return noExt.replace(/^(ja|zh-TW)\/?/, '')
}
function localeOf(relativePath: string): keyof typeof LOCALES {
  if (relativePath.startsWith('ja/')) return 'ja'
  if (relativePath.startsWith('zh-TW/')) return 'zh-TW'
  return 'root'
}
const url = (prefix: string, shared: string) => SITE + '/' + prefix + shared


// Three locales with one structure: the language menu swaps the prefix and keeps the page path.
export default withMermaid(defineConfig({
  title: 'Review Bridge',
  description: 'Work orders in, evidence out.',
  cleanUrls: true,
  appearance: 'dark',
  lastUpdated: true,
  sitemap: { hostname: SITE },
  head: [
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Review Bridge' }],
    ['meta', { property: 'og:image', content: SITE + '/og.png' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: SITE + '/og.png' }],
  ],
  // Per page: canonical, og:title/description/url, hreflang for the three locales, and JSON-LD on the home pages.
  transformHead({ pageData }) {
    const locale = localeOf(pageData.relativePath)
    const shared = sharedPath(pageData.relativePath)
    const self = url(LOCALES[locale].prefix, shared)
    const description = pageData.description || LOCALES[locale].description
    const title = pageData.title ? `${pageData.title} | Review Bridge` : 'Review Bridge'
    const head: HeadConfig[] = [
      ['link', { rel: 'canonical', href: self }],
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { property: 'og:url', content: self }],
      ['meta', { property: 'og:locale', content: LOCALES[locale].lang.replace('-', '_') }],
      ['meta', { name: 'description', content: description }],
    ]
    for (const [key, l] of Object.entries(LOCALES)) {
      head.push(['link', { rel: 'alternate', hreflang: l.lang, href: url(l.prefix, shared) }])
      if (key === 'root') head.push(['link', { rel: 'alternate', hreflang: 'x-default', href: url(l.prefix, shared) }])
    }
    if (shared === '') {
      head.push(['script', { type: 'application/ld+json' }, JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'Review Bridge',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Windows, macOS, Linux',
        softwareVersion: VERSION,
        url: self,
        inLanguage: LOCALES[locale].lang,
        description,
        downloadUrl: 'https://www.npmjs.com/package/review-bridge',
        codeRepository: 'https://github.com/fortes1219/review-bridge',
        license: 'https://opensource.org/licenses/MIT',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      })])
    }
    return head
  },
  // mermaid pulls in CommonJS packages (fastdom); Vite pre-bundles mermaid whole, or the dev server fails on their default imports.
  vite: { optimizeDeps: { include: ['mermaid'] } },
  locales: {
    "root": {
      "label": "English",
      "lang": "en",
      "themeConfig": {
        "nav": [
          {
            "text": "Guide",
            "link": "/guide/install"
          },
          {
            "text": "Concepts",
            "link": "/concepts/"
          },
          {
            "text": "Principles",
            "link": "/principles/architecture"
          },
          {
            "text": "Reference",
            "link": "/reference/cli"
          },
          {
            "text": "FAQ",
            "link": "/faq"
          },
          {
            "text": "Known issues",
            "link": "/known-issues"
          },
          {
            "text": "Release notes",
            "link": "/release-notes"
          },
          {
            "text": "v" + VERSION,
            "link": "/release-notes"
          }
        ],
        "sidebar": {
          "/guide/": [
            {
              "text": "Guide",
              "items": [
                {
                  "text": "Install and set up",
                  "link": "/guide/install"
                },
                {
                  "text": "Your first work order",
                  "link": "/guide/work-order"
                },
                {
                  "text": "Start a run",
                  "link": "/guide/start"
                },
                {
                  "text": "Results, logs and the database",
                  "link": "/guide/results"
                },
                {
                  "text": "Upgrade, back up, remove",
                  "link": "/guide/maintenance"
                }
              ]
            }
          ],
          "/concepts/": [
            {
              "text": "Concepts",
              "items": [
                {
                  "text": "Concepts",
                  "link": "/concepts/"
                }
              ]
            }
          ],
          "/principles/": [
            {
              "text": "Principles",
              "items": [
                {
                  "text": "Architecture and milestones",
                  "link": "/principles/architecture"
                },
                {
                  "text": "Why it is built this way",
                  "link": "/principles/why"
                },
                {
                  "text": "Design references",
                  "link": "/principles/references"
                },
                {
                  "text": "When Bridge needs your input",
                  "link": "/principles/asking"
                }
              ]
            }
          ],
          "/reference/": [
            {
              "text": "Reference",
              "items": [
                {
                  "text": "Commands",
                  "link": "/reference/cli"
                },
                {
                  "text": "Configuration",
                  "link": "/reference/config"
                },
                {
                  "text": "Result file",
                  "link": "/reference/result-file"
                },
                {
                  "text": "Connect your existing tools",
                  "link": "/reference/integration"
                }
              ]
            }
          ]
        }
      }
    },
    "ja": {
      "label": "日本語",
      "lang": "ja",
      "themeConfig": {
        "nav": [
          {
            "text": "ガイド",
            "link": "/ja/guide/install"
          },
          {
            "text": "概念",
            "link": "/ja/concepts/"
          },
          {
            "text": "設計原理",
            "link": "/ja/principles/architecture"
          },
          {
            "text": "リファレンス",
            "link": "/ja/reference/cli"
          },
          {
            "text": "よくある質問",
            "link": "/ja/faq"
          },
          {
            "text": "既知の問題",
            "link": "/ja/known-issues"
          },
          {
            "text": "リリースノート",
            "link": "/ja/release-notes"
          },
          {
            "text": "v" + VERSION,
            "link": "/ja/release-notes"
          }
        ],
        "sidebar": {
          "/ja/guide/": [
            {
              "text": "ガイド",
              "items": [
                {
                  "text": "インストールと初期設定",
                  "link": "/ja/guide/install"
                },
                {
                  "text": "最初の作業指示",
                  "link": "/ja/guide/work-order"
                },
                {
                  "text": "作業を実行する",
                  "link": "/ja/guide/start"
                },
                {
                  "text": "結果・ログ・データベース",
                  "link": "/ja/guide/results"
                },
                {
                  "text": "アップグレード・バックアップ・削除",
                  "link": "/ja/guide/maintenance"
                }
              ]
            }
          ],
          "/ja/concepts/": [
            {
              "text": "概念",
              "items": [
                {
                  "text": "概念",
                  "link": "/ja/concepts/"
                }
              ]
            }
          ],
          "/ja/principles/": [
            {
              "text": "設計原理",
              "items": [
                {
                  "text": "アーキテクチャとマイルストーン",
                  "link": "/ja/principles/architecture"
                },
                {
                  "text": "なぜこの設計なのか",
                  "link": "/ja/principles/why"
                },
                {
                  "text": "設計の参考資料",
                  "link": "/ja/principles/references"
                },
                {
                  "text": "ユーザーの判断が必要なとき",
                  "link": "/ja/principles/asking"
                }
              ]
            }
          ],
          "/ja/reference/": [
            {
              "text": "リファレンス",
              "items": [
                {
                  "text": "コマンド",
                  "link": "/ja/reference/cli"
                },
                {
                  "text": "設定",
                  "link": "/ja/reference/config"
                },
                {
                  "text": "結果ファイル",
                  "link": "/ja/reference/result-file"
                },
                {
                  "text": "システム連携",
                  "link": "/ja/reference/integration"
                }
              ]
            }
          ]
        }
      },
      "link": "/ja/"
    },
    "zh-TW": {
      "label": "繁體中文",
      "lang": "zh-TW",
      "themeConfig": {
        "nav": [
          {
            "text": "指南",
            "link": "/zh-TW/guide/install"
          },
          {
            "text": "概念",
            "link": "/zh-TW/concepts/"
          },
          {
            "text": "技術原理",
            "link": "/zh-TW/principles/architecture"
          },
          {
            "text": "參考",
            "link": "/zh-TW/reference/cli"
          },
          {
            "text": "常見問題",
            "link": "/zh-TW/faq"
          },
          {
            "text": "已知問題",
            "link": "/zh-TW/known-issues"
          },
          {
            "text": "發行紀錄",
            "link": "/zh-TW/release-notes"
          },
          {
            "text": "v" + VERSION,
            "link": "/zh-TW/release-notes"
          }
        ],
        "sidebar": {
          "/zh-TW/guide/": [
            {
              "text": "指南",
              "items": [
                {
                  "text": "安裝與 init",
                  "link": "/zh-TW/guide/install"
                },
                {
                  "text": "第一張工單",
                  "link": "/zh-TW/guide/work-order"
                },
                {
                  "text": "開工",
                  "link": "/zh-TW/guide/start"
                },
                {
                  "text": "結果、紀錄與資料庫",
                  "link": "/zh-TW/guide/results"
                },
                {
                  "text": "升級、備份、移除",
                  "link": "/zh-TW/guide/maintenance"
                }
              ]
            }
          ],
          "/zh-TW/concepts/": [
            {
              "text": "概念",
              "items": [
                {
                  "text": "概念",
                  "link": "/zh-TW/concepts/"
                }
              ]
            }
          ],
          "/zh-TW/principles/": [
            {
              "text": "技術原理",
              "items": [
                {
                  "text": "架構與里程碑",
                  "link": "/zh-TW/principles/architecture"
                },
                {
                  "text": "為什麼這麼設計",
                  "link": "/zh-TW/principles/why"
                },
                {
                  "text": "參考了誰",
                  "link": "/zh-TW/principles/references"
                },
                {
                  "text": "何時需要你決定",
                  "link": "/zh-TW/principles/asking"
                }
              ]
            }
          ],
          "/zh-TW/reference/": [
            {
              "text": "參考",
              "items": [
                {
                  "text": "指令",
                  "link": "/zh-TW/reference/cli"
                },
                {
                  "text": "設定",
                  "link": "/zh-TW/reference/config"
                },
                {
                  "text": "結果檔",
                  "link": "/zh-TW/reference/result-file"
                },
                {
                  "text": "串接既有系統",
                  "link": "/zh-TW/reference/integration"
                }
              ]
            }
          ]
        }
      },
      "link": "/zh-TW/"
    }
  },
  themeConfig: {
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/fortes1219/review-bridge' }, { icon: 'npm', link: 'https://www.npmjs.com/package/review-bridge' }],
  },
}))
