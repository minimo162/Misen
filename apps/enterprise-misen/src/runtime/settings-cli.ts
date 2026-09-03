/**
 * Settings helper used by launcher/launch.ps1 before the server starts (Issue #93 B).
 *
 *   settings-cli.js ensure [--settings <path>]   create the template when missing (exit 3), else validate
 *   settings-cli.js check  [--settings <path>]   validate only
 *
 * Exit codes: 0 valid, 3 template created (user must fill it in), 4 invalid or missing credential.
 * Output is Japanese and never contains the credential.
 */
import { BrainProfileError, defaultSettingsPath, describeBrainProfile, ensureSettingsTemplate, loadBrainProfile } from './brain-profile.js'
import { createBrain } from './brain.js'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main(): Promise<number> {
  const command = process.argv[2]
  const settingsPath = argument('--settings') ?? defaultSettingsPath()
  if (command !== 'ensure' && command !== 'check') {
    console.error('使い方: settings-cli.js ensure|check [--settings <path>]')
    return 2
  }
  if (command === 'ensure') {
    const outcome = await ensureSettingsTemplate(settingsPath)
    if (outcome === 'created') {
      console.log('LLM 接続設定のテンプレートを作成しました。')
      console.log(`  ${settingsPath}`)
      console.log('このファイルにプロバイダー種別・モデル名・API キーを記入して保存し、Misen起動.cmd をもう一度ダブルクリックしてください。')
      return 3
    }
  }
  try {
    const profile = await loadBrainProfile(settingsPath)
    createBrain(profile)
    const identity = describeBrainProfile(profile)
    console.log(`LLM 接続設定: provider=${identity.provider} model=${identity.model}${identity.baseUrl ? ` baseUrl=${identity.baseUrl}` : ''} credential=${identity.credentialSource}${identity.credentialEnv ? `(${identity.credentialEnv})` : ''}`)
    return 0
  } catch (error) {
    if (error instanceof BrainProfileError) {
      console.error('LLM 接続設定に問題があります。')
      console.error(`  ${error.settingsPath}`)
      console.error(`  ${error.message}`)
      return 4
    }
    console.error(`LLM 接続設定を確認できませんでした: ${error instanceof Error ? error.message : String(error)}`)
    return 4
  }
}

process.exitCode = await main()
