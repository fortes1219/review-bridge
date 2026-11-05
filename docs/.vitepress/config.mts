import { defineConfig } from 'vitepress'

// Three locales with one structure: the language menu swaps the prefix and keeps the page path.
export default defineConfig({
  title: 'Review Bridge',
  description: 'Work orders in, evidence out.',
  cleanUrls: true,
  appearance: 'dark',
  lastUpdated: true,
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
                  "text": "Install and init",
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
            "text": "概念",
            "link": "/ja/concepts/"
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
                  "text": "インストールと init",
                  "link": "/ja/guide/install"
                },
                {
                  "text": "最初の作業指示",
                  "link": "/ja/guide/work-order"
                },
                {
                  "text": "run を開始する",
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
            "text": "參考",
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
})
