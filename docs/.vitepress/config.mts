import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

// Three locales with one structure: the language menu swaps the prefix and keeps the page path.
export default withMermaid(defineConfig({
  title: 'Review Bridge',
  description: 'Work orders in, evidence out.',
  cleanUrls: true,
  appearance: 'dark',
  lastUpdated: true,
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
            "text": "Design principles",
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
            "text": "Release notes",
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
                  "text": "Results, logs, and the database",
                  "link": "/guide/results"
                },
                {
                  "text": "Upgrade, back up, and uninstall",
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
              "text": "Design principles",
              "items": [
                {
                  "text": "Architecture and roadmap",
                  "link": "/principles/architecture"
                },
                {
                  "text": "Design decisions",
                  "link": "/principles/why"
                },
                {
                  "text": "Design references",
                  "link": "/principles/references"
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
            "text": "基本概念",
            "link": "/ja/concepts/"
          },
          {
            "text": "設計方針",
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
            "text": "リリースノート",
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
              "text": "基本概念",
              "items": [
                {
                  "text": "基本概念",
                  "link": "/ja/concepts/"
                }
              ]
            }
          ],
          "/ja/principles/": [
            {
              "text": "設計方針",
              "items": [
                {
                  "text": "アーキテクチャとロードマップ",
                  "link": "/ja/principles/architecture"
                },
                {
                  "text": "設計の理由",
                  "link": "/ja/principles/why"
                },
                {
                  "text": "設計の参考資料",
                  "link": "/ja/principles/references"
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
            "text": "設計原理",
            "link": "/zh-TW/principles/architecture"
          },
          {
            "text": "參考文件",
            "link": "/zh-TW/reference/cli"
          },
          {
            "text": "常見問題",
            "link": "/zh-TW/faq"
          },
          {
            "text": "發行紀錄",
            "link": "/zh-TW/release-notes"
          }
        ],
        "sidebar": {
          "/zh-TW/guide/": [
            {
              "text": "指南",
              "items": [
                {
                  "text": "安裝與初始化",
                  "link": "/zh-TW/guide/install"
                },
                {
                  "text": "第一張工單",
                  "link": "/zh-TW/guide/work-order"
                },
                {
                  "text": "開始執行",
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
              "text": "設計原理",
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
                  "text": "設計參考",
                  "link": "/zh-TW/principles/references"
                }
              ]
            }
          ],
          "/zh-TW/reference/": [
            {
              "text": "參考文件",
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
