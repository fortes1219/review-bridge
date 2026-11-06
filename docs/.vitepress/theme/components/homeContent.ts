/**
 * Content-only placeholders. Replace here; no product claims or fake metrics.
 * No layout/interaction/style code should require changing when copy is updated.
 */
export type HomeLocale = 'zh-TW' | 'en-US' | 'ja'
export type FeatureIcon = 'layers' | 'shield' | 'hourglass' | 'git'
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
  features: HomeFeature[]
  steps: HomeStep[]
}

export const HOME_CONTENT: Record<HomeLocale, HomeContent> = {
  'zh-TW': {
    eyebrow: 'AI WORK AUDIT & VERIFICATION HARNESS',
    productName: 'Review Bridge',
    titleFirst: '讓 AI 執行工單，',
    titleAccent: '用證據驗收成果。',
    lead: 'AI 工作的艦橋。你確認計畫，一個 agent 負責實作，Bridge 執行測試，再由另一個獨立的唯讀 agent 審查。授權、修改與驗收結果，都有紀錄可查。',
    primaryAction: '開始使用',
    workflowLabel: '工作流程',
    features: [
      { id: 'feature-1', icon: 'layers', kicker: 'MODULE / 01', title: '固定驗收依據', description: '工單轉成合約後，以 SHA-256 封存。實作與審查都依據同一份合約，保留當時的版本供你核對。' },
      { id: 'feature-2', icon: 'shield', kicker: 'MODULE / 02', title: '獨立的唯讀審查', description: 'reviewer 使用獨立 session。執行前，Bridge 會檢查唯讀限制，並保留檢查結果。' },
      { id: 'feature-3', icon: 'hourglass', kicker: 'MODULE / 03', title: '人工授權，紀錄可查', description: '由你確認卡片上的工單計畫，Bridge 記錄授權內容與來源。授權紀錄一經建立，就不再變更。' },
      { id: 'feature-4', icon: 'git', kicker: 'MODULE / 04', title: '從 Git 核對修改內容', description: 'Bridge 從 Git 取得實際改動，另外列出代理回報的內容，並在結果中附上驗證證據。' },
    ],
    steps: [
      { id: 'step-1', icon: 'file', label: '建立工單' },
      { id: 'step-2', icon: 'key', label: '授權執行' },
      { id: 'step-3', icon: 'code', label: '實作與測試' },
      { id: 'step-4', icon: 'check', label: '獨立審查' },
      { id: 'step-5', icon: 'database', label: '查閱結果' },
    ],
  },
  'en-US': {
    eyebrow: 'AI WORK AUDIT & VERIFICATION HARNESS',
    productName: 'Review Bridge',
    titleFirst: 'Work orders in, ',
    titleAccent: 'evidence out.',
    lead: 'The command bridge for AI work. You approve the plan. A writer makes the changes, Bridge runs your configured tests, and an independent read-only reviewer checks the result. Every run leaves a record you can inspect.',
    primaryAction: 'Get started',
    workflowLabel: 'Workflow',
    features: [
      { id: 'feature-1', icon: 'layers', kicker: 'MODULE / 01', title: 'A fixed basis for review', description: 'After authorization, Bridge turns the work order into a contract and seals it with SHA-256. The writer and reviewer work from that same contract.' },
      { id: 'feature-2', icon: 'shield', kicker: 'MODULE / 02', title: 'Independent, read-only review', description: 'The reviewer runs in a separate session. Bridge checks its read-only restrictions before work begins and keeps the evidence.' },
      { id: 'feature-3', icon: 'hourglass', kicker: 'MODULE / 03', title: 'Human approval on record', description: 'You approve the plan shown on the card. Bridge records what you authorized and how you authorized it. That record cannot be changed.' },
      { id: 'feature-4', icon: 'git', kicker: 'MODULE / 04', title: 'Changes checked against Git', description: 'Bridge reads the actual changes from Git and lists the agent’s claims separately. The result includes the evidence used to check the work.' },
    ],
    steps: [
      { id: 'step-1', icon: 'file', label: 'Write the order' },
      { id: 'step-2', icon: 'key', label: 'Authorize' },
      { id: 'step-3', icon: 'code', label: 'Write and test' },
      { id: 'step-4', icon: 'check', label: 'Independent review' },
      { id: 'step-5', icon: 'database', label: 'Inspect the result' },
    ],
  },
  'ja': {
    eyebrow: 'AI WORK AUDIT & VERIFICATION HARNESS',
    productName: 'Review Bridge',
    titleFirst: 'AI に作業を任せ、',
    titleAccent: '根拠に基づいて検証する。',
    lead: 'AI の作業を指揮する艦橋。あなたが計画を承認し、writer が実装、Bridge が設定済みのテスト、独立した読み取り専用の reviewer が審査を担当します。承認、変更、受け入れ判定の記録を後から確認できます。',
    primaryAction: 'はじめる',
    workflowLabel: 'ワークフロー',
    features: [
      { id: 'feature-1', icon: 'layers', kicker: 'MODULE / 01', title: '検証の基準を固定', description: '承認後、作業指示をコントラクトに変換し、SHA-256 で内容を固定します。実装とレビューは同じコントラクトに基づきます。' },
      { id: 'feature-2', icon: 'shield', kicker: 'MODULE / 02', title: '独立した読み取り専用レビュー', description: 'reviewer は別セッションで動作します。開始前に読み取り専用の制限を確認し、その結果を記録します。' },
      { id: 'feature-3', icon: 'hourglass', kicker: 'MODULE / 03', title: '承認内容を記録', description: 'カードの実行計画をあなたが承認します。何を、どの経路で承認したかを記録し、作成後は変更しません。' },
      { id: 'feature-4', icon: 'git', kicker: 'MODULE / 04', title: 'Git から変更を確認', description: 'Git で取得した実際の変更と、エージェントの報告を分けて表示します。結果には検証に使った根拠も残します。' },
    ],
    steps: [
      { id: 'step-1', icon: 'file', label: '作業指示を作成' },
      { id: 'step-2', icon: 'key', label: '実行を承認' },
      { id: 'step-3', icon: 'code', label: '実装とテスト' },
      { id: 'step-4', icon: 'check', label: '独立レビュー' },
      { id: 'step-5', icon: 'database', label: '結果を確認' },
    ],
  },
}
