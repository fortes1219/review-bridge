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
    eyebrow: 'REVIEW BRIDGE',
    productName: 'Review Bridge',
    titleFirst: '工單進，',
    titleAccent: '證據出。',
    lead: '給 agent 工作的艦橋：每條 run 都被封存、授權，由一個 agent 寫、測試驗、獨立的唯讀 reviewer 審，全部留下紀錄。',
    primaryAction: '開始使用',
    workflowLabel: '工作流程',
    features: [
      { id: 'feature-1', icon: 'layers', kicker: 'MODULE / 01', title: '封存的合約', description: '工單先翻成合約、以 SHA-256 封存，然後才開工。授權的是什麼，跑的就是什麼。' },
      { id: 'feature-2', icon: 'shield', kicker: 'MODULE / 02', title: '唯讀的 reviewer，有證據', description: '獨立的 agent 審查工作。開工前先證明它寫不了檔，證據留下紀錄。' },
      { id: 'feature-3', icon: 'hourglass', kicker: 'MODULE / 03', title: '一次 y，永久紀錄', description: '每條 run 由人授權。那個 y 對著合約雜湊記下來，之後不會變。' },
      { id: 'feature-4', icon: 'git', kicker: 'MODULE / 04', title: '工作證明來自 Git', description: '改了什麼從 repo 讀，不是 agent 說了算。測試真的跑，結果附引用行號。' },
    ],
    steps: [
      { id: 'step-1', icon: 'file', label: '建立工單' },
      { id: 'step-2', icon: 'key', label: '授權執行' },
      { id: 'step-3', icon: 'code', label: '執行驗證' },
      { id: 'step-4', icon: 'check', label: '獨立審查' },
      { id: 'step-5', icon: 'database', label: '產生證據' },
    ],
  },
  'en-US': {
    eyebrow: 'REVIEW BRIDGE',
    productName: 'Review Bridge',
    titleFirst: 'Work orders in,',
    titleAccent: 'evidence out.',
    lead: 'A command bridge for agent-driven work: every run is sealed, authorized, written by one agent, verified by tests, checked by an independent read-only reviewer, and recorded.',
    primaryAction: 'Get started',
    workflowLabel: 'Workflow',
    features: [
      { id: 'feature-1', icon: 'layers', kicker: 'MODULE / 01', title: 'Sealed contract', description: 'The work order is translated into a contract and sealed by SHA-256 before anything runs. What was authorized is what ran.' },
      { id: 'feature-2', icon: 'shield', kicker: 'MODULE / 02', title: 'Read-only reviewer, with proof', description: 'An independent agent checks the work. Bridge proves it cannot write before the run, and records the evidence.' },
      { id: 'feature-3', icon: 'hourglass', kicker: 'MODULE / 03', title: 'One yes, kept forever', description: 'A person authorizes each run. The yes is recorded against the contract hash and never changes.' },
      { id: 'feature-4', icon: 'git', kicker: 'MODULE / 04', title: 'Work proof from Git', description: 'What changed comes from the repository, not from what an agent says. Tests run for real; the result cites lines.' },
    ],
    steps: [
      { id: 'step-1', icon: 'file', label: 'Write the order' },
      { id: 'step-2', icon: 'key', label: 'Authorize' },
      { id: 'step-3', icon: 'code', label: 'Write and test' },
      { id: 'step-4', icon: 'check', label: 'Independent review' },
      { id: 'step-5', icon: 'database', label: 'Evidence' },
    ],
  },
  'ja': {
    eyebrow: 'REVIEW BRIDGE',
    productName: 'Review Bridge',
    titleFirst: '作業指示を入れ、',
    titleAccent: '証拠を出す。',
    lead: 'エージェント作業のための艦橋。すべての run は封印・承認され、一つのエージェントが書き、テストで検証し、独立した読み取り専用レビュアーが確認し、記録されます。',
    primaryAction: 'はじめる',
    workflowLabel: 'ワークフロー',
    features: [
      { id: 'feature-1', icon: 'layers', kicker: 'MODULE / 01', title: '封印された契約', description: '作業指示は契約に変換され、実行前に SHA-256 で封印されます。承認した内容がそのまま実行されます。' },
      { id: 'feature-2', icon: 'shield', kicker: 'MODULE / 02', title: '読み取り専用のレビュアー、証拠つき', description: '独立したエージェントが作業を確認します。実行前に書き込めないことを証明し、証拠を記録します。' },
      { id: 'feature-3', icon: 'hourglass', kicker: 'MODULE / 03', title: '一度の承認、永久に記録', description: '各 run は人が承認します。承認は契約ハッシュに紐づいて記録され、変更されません。' },
      { id: 'feature-4', icon: 'git', kicker: 'MODULE / 04', title: 'Git による作業証明', description: '変更内容はリポジトリから取得され、エージェントの申告ではありません。テストは実際に実行され、結果は行番号を引用します。' },
    ],
    steps: [
      { id: 'step-1', icon: 'file', label: '作業指示を書く' },
      { id: 'step-2', icon: 'key', label: '承認' },
      { id: 'step-3', icon: 'code', label: '実装とテスト' },
      { id: 'step-4', icon: 'check', label: '独立レビュー' },
      { id: 'step-5', icon: 'database', label: '証拠' },
    ],
  },
}
