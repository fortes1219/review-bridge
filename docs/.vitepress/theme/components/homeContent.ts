/**
 * Content-only placeholders. Replace here; no product claims or fake metrics.
 * No layout/interaction/style code should require changing when copy is updated.
 */
export type HomeLocale = 'zh-TW' | 'en-US' | 'ja'
export type FeatureIcon = 'layers' | 'shield' | 'hourglass' | 'git' | 'gauge' | 'database'
export type StepIcon = 'file' | 'key' | 'code' | 'check' | 'database'

export interface HomeFeature {
  id: string
  icon: FeatureIcon
  kicker: string
  title: string
  description: string
}

export interface HomeStep {
  id: string
  icon: StepIcon
  label: string
}

export interface HomeContent {
  eyebrow: string
  productName: string
  titleFirst: string
  titleAccent: string
  lead: string
  primaryAction: string
  workflowLabel: string
  articleLead: string
  articleTitle: string
  features: HomeFeature[]
  steps: HomeStep[]
}

export const HOME_CONTENT: Record<HomeLocale, HomeContent> = {
  'zh-TW': {
    eyebrow: 'AI WORK AUDIT & VERIFICATION HARNESS',
    productName: 'Review Bridge',
    titleFirst: '掌握 AI 輔助開發的',
    titleAccent: '每一個細節。',
    lead: 'AI 工作稽核驗證工具，從工單授權、範圍與預算控管，到獨立審查與驗證紀錄，讓 AI 在明確規則下工作，每次交付都有依據可查。',
    primaryAction: '開始使用',
    workflowLabel: '工作流程',
    articleLead: '這套做法的來龍去脈：',
    articleTitle: 'AI 導入後，工程團隊真正要管理的是交付鏈路與驗證責任（HackMD）',
    features: [
      { id: 'feature-1', icon: 'layers', kicker: 'MODULE / 01', title: '依據封存合約執行', description: 'Bridge 依工單內容建立並封存合約，不呼叫模型。你確認卡片上的內容、範圍與預算後，writer 與 reviewer 才依這份合約實作與審查。' },
      { id: 'feature-2', icon: 'shield', kicker: 'MODULE / 02', title: '獨立、唯讀的審查', description: 'reviewer 使用獨立工作階段，以唯讀方式檢查成果。Bridge 會在開工前檢查其權限限制，並保留檢查證據。' },
      { id: 'feature-3', icon: 'hourglass', kicker: 'MODULE / 03', title: '每次授權都有依據', description: '授權紀錄綁定你確認的工單與執行計畫，建立後不可變更。事後可查明當時核准的內容；修改工單後重新開工，則需重新授權。' },
      { id: 'feature-4', icon: 'git', kicker: 'MODULE / 04', title: '從 Git 核對實際改動', description: '使用 Git 的專案，結果檔會分列實際改動、writer 回報的內容，以及執行前已存在的修改，方便你核對本次成果。' },
      { id: 'feature-5', icon: 'gauge', kicker: 'MODULE / 05', title: '限制預算與執行時間', description: 'policy 限制 writer 的 token 預算、執行輪數與時間，工單只能在上限內調整。超限後由 Bridge 停止後續執行；reviewer 用量另行記錄，不計入 token 預算。' },
      { id: 'feature-6', icon: 'database', kicker: 'MODULE / 06', title: '執行紀錄集中查詢', description: '工單各版、授權、合約、審查判定與交付結果，都記錄在 PostgreSQL。你可以查詢各次執行，追溯工作的依據與結果。' },
    ],
    steps: [
      { id: 'step-1', icon: 'file', label: '建立工單' },
      { id: 'step-2', icon: 'key', label: '授權執行' },
      { id: 'step-3', icon: 'code', label: '實作與驗證' },
      { id: 'step-4', icon: 'check', label: '獨立審查' },
      { id: 'step-5', icon: 'database', label: '交付成果與紀錄' },
    ],
  },
  'en-US': {
    eyebrow: 'AI WORK AUDIT & VERIFICATION HARNESS',
    productName: 'Review Bridge',
    titleFirst: 'AI coding ',
    titleAccent: 'you can audit.',
    lead: 'Run coding agents with approved plans, enforced budgets, and independent review. Review Bridge records approvals, code changes, test results, and review findings so you can check what was authorized and what was delivered.',
    primaryAction: 'Get started',
    workflowLabel: 'How it works',
    articleLead: 'The ideas behind Review Bridge: ',
    articleTitle: 'AI adoption: managing delivery and verification responsibilities (HackMD, in Chinese)',
    features: [
      { id: 'feature-1', icon: 'layers', kicker: 'MODULE / 01', title: 'Work from a sealed contract', description: 'Bridge creates and seals the contract from your work order without calling a model. You approve the card before work starts, giving the writer and reviewer the same requirements, scope, and budget to work from.' },
      { id: 'feature-2', icon: 'shield', kicker: 'MODULE / 02', title: 'Independent, read-only review', description: 'The reviewer checks the work in a separate session with read-only access. Bridge checks its read-only configuration before work starts and saves the verification results.' },
      { id: 'feature-3', icon: 'hourglass', kicker: 'MODULE / 03', title: 'Know what you authorized', description: 'Each approval records the work order and plan you authorized. The record cannot be changed afterward, and an edited work order needs a new approval before it can run.' },
      { id: 'feature-4', icon: 'git', kicker: 'MODULE / 04', title: 'Check changes against Git', description: 'For projects using Git, the report lists actual file changes, the writer\'s own report, and edits that predate the run in separate sections. You can compare them when reviewing the results.' },
      { id: 'feature-5', icon: 'gauge', kicker: 'MODULE / 05', title: 'Enforce budgets and time limits', description: 'Policy sets the writer\'s token budget, iteration limits, and time limits. Work orders can lower those limits, and agents cannot raise them. Bridge stops when a limit is reached; reviewer usage is recorded separately from the token budget.' },
      { id: 'feature-6', icon: 'database', kicker: 'MODULE / 06', title: 'Query the execution history', description: 'PostgreSQL stores work order versions, approvals, contracts, review verdicts, and results. Query records across runs to trace what was approved, reviewed, and delivered.' },
    ],
    steps: [
      { id: 'step-1', icon: 'file', label: 'Write a work order' },
      { id: 'step-2', icon: 'key', label: 'Approve the plan' },
      { id: 'step-3', icon: 'code', label: 'Implement and verify' },
      { id: 'step-4', icon: 'check', label: 'Independent review' },
      { id: 'step-5', icon: 'database', label: 'Review the results' },
    ],
  },
  'ja': {
    eyebrow: 'AI WORK AUDIT & VERIFICATION HARNESS',
    productName: 'Review Bridge',
    titleFirst: 'AIと進める開発を、',
    titleAccent: '管理できる仕組みへ。',
    lead: '作業の承認から、変更範囲・予算の制限、独立レビュー、検証結果の記録まで。Review Bridgeは、AIエージェントの作業を管理し、成果の根拠を確認するためのツールです。',
    primaryAction: 'はじめる',
    workflowLabel: '作業の流れ',
    articleLead: '設計の背景：',
    articleTitle: 'AI導入後のチームに求められる、開発プロセスの管理と検証の責任（HackMD・中国語）',
    features: [
      { id: 'feature-1', icon: 'layers', kicker: 'MODULE / 01', title: '契約を確定して実行', description: 'Bridgeが作業指示からコントラクトを作成・固定します。モデルは使いません。ユーザーがカードで内容・範囲・予算を承認し、writerとreviewerは同じコントラクトに沿って実装・審査します。' },
      { id: 'feature-2', icon: 'shield', kicker: 'MODULE / 02', title: '独立した読み取り専用レビュー', description: 'reviewerは独立したセッションを使い、読み取り専用の権限で成果を確認します。Bridgeは作業開始前に読み取り専用の制限を検証し、結果を記録します。' },
      { id: 'feature-3', icon: 'hourglass', kicker: 'MODULE / 03', title: '承認内容をあとから確認', description: '承認は、その時点の作業指示と実行計画に紐づけて記録され、あとから変更できません。作業指示を編集して再実行する場合は、新たに承認が必要です。' },
      { id: 'feature-4', icon: 'git', kicker: 'MODULE / 04', title: 'Gitで実際の変更を確認', description: 'Gitを使うプロジェクトでは、実際の変更、writerが報告した変更、実行前からあった変更を結果ファイルに分けて表示します。今回の作業結果を照合できます。' },
      { id: 'feature-5', icon: 'gauge', kicker: 'MODULE / 05', title: '予算と実行時間に上限を設定', description: 'ポリシーがwriterのトークン予算、実行回数、時間に上限を設けます。作業指示では上限内で調整でき、超過時はBridgeが停止します。reviewerの使用量は別途記録し、トークン予算には含めません。' },
      { id: 'feature-6', icon: 'database', kicker: 'MODULE / 06', title: '実行履歴を一か所で確認', description: '作業指示の各バージョン、承認、契約、レビューの判定、成果をPostgreSQLに記録します。実行ごとの記録を照会し、作業の根拠と結果をたどれます。' },
    ],
    steps: [
      { id: 'step-1', icon: 'file', label: '依頼内容を記入' },
      { id: 'step-2', icon: 'key', label: '実行計画を承認' },
      { id: 'step-3', icon: 'code', label: '実装・検証' },
      { id: 'step-4', icon: 'check', label: '独立したレビュー' },
      { id: 'step-5', icon: 'database', label: '成果と記録を確認' },
    ],
  },
}
