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
    eyebrow: 'AI REVIEW HARNESS',
    productName: 'Review Bridge',
    titleFirst: '工單進，',
    titleAccent: '證據出。',
    lead: '給 agent 工作的艦橋：每條 run 都被封存、授權，預算由 Bridge 控制，由一個 agent 寫、測試驗、獨立的唯讀 reviewer 審，全部留下紀錄。',
    primaryAction: '開始使用',
    workflowLabel: '工作流程',
    articleLead: '這套做法的來龍去脈：',
    articleTitle: 'AI 導入後，工程團隊真正要管理的是交付鏈路與驗證責任（HackMD）',
    features: [
      { id: 'feature-1', icon: 'layers', kicker: 'MODULE / 01', title: '封存的合約', description: '工單先翻成合約、以 SHA-256 封存，然後才開工。授權的是什麼，跑的就是什麼。' },
      { id: 'feature-2', icon: 'shield', kicker: 'MODULE / 02', title: '唯讀的 reviewer，有證據', description: '獨立的 agent 審查工作。開工前先證明它寫不了檔，證據留下紀錄。' },
      { id: 'feature-3', icon: 'hourglass', kicker: 'MODULE / 03', title: '一次 y，永久紀錄', description: '每條 run 由人授權。那個 y 對著合約雜湊記下來，之後不會變。' },
      { id: 'feature-4', icon: 'git', kicker: 'MODULE / 04', title: '工作證明來自 Git', description: '改了什麼從 repo 讀，不是 agent 說了算。測試真的跑，結果附引用行號。' },
      { id: 'feature-5', icon: 'gauge', kicker: 'MODULE / 05', title: '預算在 harness 手上', description: 'token、回數、每次呼叫與整條 run 的時間上限寫在 policy，工單只能往下調。agent 改不了，超過就收掉。' },
      { id: 'feature-6', icon: 'database', kicker: 'MODULE / 06', title: '每一步都是資料庫的一列', description: '工單版本、合約、授權、run、判定、交付全進 PostgreSQL，SQL 查得到；結果檔只是給你的副本。' },
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
    eyebrow: 'AI REVIEW HARNESS',
    productName: 'Review Bridge',
    titleFirst: 'Work orders in, ',
    titleAccent: 'evidence out.',
    lead: 'A command bridge for agent-driven work: every run is sealed, authorized, budgeted by Bridge, written by one agent, verified by tests, checked by an independent read-only reviewer, and recorded.',
    primaryAction: 'Get started',
    workflowLabel: 'Workflow',
    articleLead: 'The thinking behind it: ',
    articleTitle: 'After AI adoption, what an engineering team really manages is the delivery chain and the duty to verify (HackMD, Chinese)',
    features: [
      { id: 'feature-1', icon: 'layers', kicker: 'MODULE / 01', title: 'Sealed contract', description: 'The work order is translated into a contract and sealed by SHA-256 before anything runs. What was authorized is what ran.' },
      { id: 'feature-2', icon: 'shield', kicker: 'MODULE / 02', title: 'Read-only reviewer, with proof', description: 'An independent agent checks the work. Bridge proves it cannot write before the run, and records the evidence.' },
      { id: 'feature-3', icon: 'hourglass', kicker: 'MODULE / 03', title: 'One yes, kept forever', description: 'A person authorizes each run. The yes is recorded against the contract hash and never changes.' },
      { id: 'feature-4', icon: 'git', kicker: 'MODULE / 04', title: 'Work proof from Git', description: 'What changed comes from the repository, not from what an agent says. Tests run for real; the result cites lines.' },
      { id: 'feature-5', icon: 'gauge', kicker: 'MODULE / 05', title: 'The harness holds the budget', description: 'Tokens, rounds, per-call and per-run time limits live in the policy; a work order can only lower them. Agents cannot change them, and a run that exceeds them is closed.' },
      { id: 'feature-6', icon: 'database', kicker: 'MODULE / 06', title: 'Every step is a row', description: 'Work order versions, contracts, authorizations, runs, verdicts and deliveries all go into PostgreSQL, queryable by SQL; the result file is only your copy.' },
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
    eyebrow: 'AI REVIEW HARNESS',
    productName: 'Review Bridge',
    titleFirst: '作業指示を入れ、',
    titleAccent: '証拠を出す。',
    lead: 'エージェント作業のための艦橋。すべての run は封印・承認され、予算は Bridge が管理し、一つのエージェントが書き、テストで検証し、独立した読み取り専用レビュアーが確認し、記録されます。',
    primaryAction: 'はじめる',
    workflowLabel: 'ワークフロー',
    articleLead: 'この考え方の背景：',
    articleTitle: 'AI 導入後、エンジニアリングチームが本当に管理すべきは提供チェーンと検証責任（HackMD、中国語）',
    features: [
      { id: 'feature-1', icon: 'layers', kicker: 'MODULE / 01', title: '封印された契約', description: '作業指示は契約に変換され、実行前に SHA-256 で封印されます。承認した内容がそのまま実行されます。' },
      { id: 'feature-2', icon: 'shield', kicker: 'MODULE / 02', title: '読み取り専用のレビュアー、証拠つき', description: '独立したエージェントが作業を確認します。実行前に書き込めないことを証明し、証拠を記録します。' },
      { id: 'feature-3', icon: 'hourglass', kicker: 'MODULE / 03', title: '一度の承認、永久に記録', description: '各 run は人が承認します。承認は契約ハッシュに紐づいて記録され、変更されません。' },
      { id: 'feature-4', icon: 'git', kicker: 'MODULE / 04', title: 'Git による作業証明', description: '変更内容はリポジトリから取得され、エージェントの申告ではありません。テストは実際に実行され、結果は行番号を引用します。' },
      { id: 'feature-5', icon: 'gauge', kicker: 'MODULE / 05', title: '予算はハーネスが握る', description: 'トークン、ラウンド数、呼び出しごと・run ごとの時間上限はポリシーに書かれ、作業指示は下げることしかできません。エージェントは変更できず、超えた run は閉じられます。' },
      { id: 'feature-6', icon: 'database', kicker: 'MODULE / 06', title: 'すべての段階が一行の記録', description: '作業指示の版、契約、承認、run、判定、納品はすべて PostgreSQL に入り、SQL で参照できます。結果ファイルはあなた用の写しです。' },
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
