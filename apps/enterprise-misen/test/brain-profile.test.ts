import test from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  API_KEY_PLACEHOLDER,
  BrainProfileError,
  defaultSettingsPath,
  describeBrainProfile,
  ensureSettingsTemplate,
  KEYLESS_CREDENTIAL,
  loadBrainProfile,
  parseBrainSettings,
  SETTINGS_TEMPLATE,
  stripJsonComments,
} from '../src/runtime/brain-profile.js'
import { createBrain } from '../src/runtime/brain.js'

const SECRET = 'sk-unit-test-secret-ZZ9'
const settingsPath = 'C:\\fake\\settings.json'
const settings = (brain: Record<string, unknown>) => JSON.stringify({ schema: 'misen-settings/1', brain })
const parse = (brain: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) => parseBrainSettings(settings(brain), settingsPath, env)
const rejects = (brain: Record<string, unknown>, code: BrainProfileError['code'], pattern?: RegExp, env: NodeJS.ProcessEnv = {}) => {
  try {
    parse(brain, env)
  } catch (error) {
    assert.ok(error instanceof BrainProfileError, `expected BrainProfileError for ${JSON.stringify(brain)}`)
    assert.equal(error.code, code, `${JSON.stringify(brain)} -> ${error.message}`)
    if (pattern) assert.match(error.message, pattern)
    assert.ok(!error.message.includes(SECRET), 'error messages never carry the secret')
    return
  }
  assert.fail(`expected rejection for ${JSON.stringify(brain)}`)
}

test('the commented template parses once the placeholder is replaced and is the current openai/gpt-5.6-luna profile', () => {
  assert.throws(() => parseBrainSettings(SETTINGS_TEMPLATE, settingsPath), (error: unknown) => error instanceof BrainProfileError && error.code === 'credential' && error.message.includes('テンプレート'))
  const profile = parseBrainSettings(SETTINGS_TEMPLATE.replace(API_KEY_PLACEHOLDER, SECRET), settingsPath)
  assert.equal(profile.provider, 'openai')
  assert.equal(profile.model, 'gpt-5.6-luna')
  assert.equal(profile.thinkingLevel, 'medium')
  assert.equal(profile.baseUrl, undefined)
  assert.equal(profile.credentialSource, 'settings')
  assert.equal(profile.credential(), SECRET)
  assert.ok(Object.isFrozen(profile))
  assert.match(SETTINGS_TEMPLATE, /共有フォルダーには置かないでください/u)
})

test('the secret is reachable only through the credential closure, never through serialization or the audit identity', () => {
  const profile = parse({ provider: 'openai', model: 'gpt-5.6-luna', apiKey: SECRET })
  assert.ok(!JSON.stringify(profile).includes(SECRET))
  assert.ok(!Object.keys(profile).includes('credential'))
  assert.ok(!JSON.stringify(describeBrainProfile(profile)).includes(SECRET))
  assert.ok(!String(profile).includes(SECRET))
  assert.ok(!JSON.stringify(Object.getOwnPropertyDescriptors(profile)).includes(SECRET))
  assert.deepEqual(describeBrainProfile(profile), { provider: 'openai', model: 'gpt-5.6-luna', baseUrl: undefined, thinkingLevel: 'medium', credentialSource: 'settings', credentialEnv: undefined, settingsPath })
})

test('credential may reference a deployment-injected environment variable and fails closed when it is absent', () => {
  const profile = parse({ provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: { env: 'MISEN_TEST_BRAIN_KEY' } }, { MISEN_TEST_BRAIN_KEY: SECRET })
  assert.equal(profile.credentialSource, 'env')
  assert.equal(profile.credentialEnv, 'MISEN_TEST_BRAIN_KEY')
  assert.equal(profile.credential(), SECRET)
  assert.ok(!JSON.stringify(profile).includes(SECRET))
  rejects({ provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: { env: 'MISEN_TEST_BRAIN_KEY' } }, 'credential', /MISEN_TEST_BRAIN_KEY/u, {})
  rejects({ provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: { env: 'lower-case' } }, 'invalid')
  rejects({ provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: { env: 'X', extra: true } }, 'invalid')
})

test('malformed or unapproved settings fail closed with Japanese guidance', () => {
  assert.throws(() => parseBrainSettings('{ not json', settingsPath), (error: unknown) => error instanceof BrainProfileError && error.code === 'invalid')
  assert.throws(() => parseBrainSettings(JSON.stringify({ schema: 'other', brain: {} }), settingsPath), (error: unknown) => error instanceof BrainProfileError && /schema/u.test(error.message))
  assert.throws(() => parseBrainSettings(JSON.stringify({ schema: 'misen-settings/1' }), settingsPath), (error: unknown) => error instanceof BrainProfileError && /brain/u.test(error.message))
  rejects({ provider: 'gemini', model: 'x', apiKey: SECRET }, 'unsupported', /provider/u)
  rejects({ provider: 'openai', apiKey: SECRET }, 'invalid', /brain\.model/u)
  rejects({ provider: 'openai', model: 'gpt-5.6-luna', apiKey: SECRET, baseUrl: 'https://proxy.example/v1' }, 'unsupported', /baseUrl/u)
  rejects({ provider: 'openai', model: 'gpt-5.6-luna' }, 'credential', /apiKey/u)
  rejects({ provider: 'openai', model: 'gpt-5.6-luna', apiKey: '' }, 'credential')
  rejects({ provider: 'openai', model: 'gpt-5.6-luna', apiKey: 'sk-with space' }, 'invalid')
  rejects({ provider: 'openai', model: 'gpt-5.6-luna', apiKey: SECRET, thinkingLevel: 'ultra' }, 'invalid', /thinkingLevel/u)
  rejects({ provider: 'openai', model: 'gpt-5.6-luna', apiKey: SECRET, endpoint: 'x' }, 'invalid', /未知の設定項目/u)
  rejects({ provider: 'openai', model: 'gpt-5.6-luna', apiKey: SECRET, contextWindow: 1000 }, 'unsupported')
  rejects({ provider: 'openai-compatible', model: 'local' }, 'invalid', /baseUrl が必須/u)
  rejects({ provider: 'openai-compatible', model: 'local', baseUrl: 'ftp://host/v1' }, 'invalid')
  rejects({ provider: 'openai-compatible', model: 'local', baseUrl: 'http://user:pw@host/v1' }, 'invalid', /認証情報/u)
  rejects({ provider: 'openai-compatible', model: 'local', baseUrl: 'http://host/v1?x=1' }, 'invalid')
  rejects({ provider: 'openai-compatible', model: 'local', baseUrl: 'http://host/v1', maxTokens: -1 }, 'invalid')
  rejects({ provider: 'openai-compatible', model: 'local', baseUrl: 'http://host/v1', apiKey: 42 }, 'invalid')
})

test('openai-compatible profiles keep the configured endpoint, default limits, and allow keyless endpoints', () => {
  const profile = parse({ provider: 'openai-compatible', model: 'qwen-local', baseUrl: 'http://127.0.0.1:11434/v1/' })
  assert.equal(profile.baseUrl, 'http://127.0.0.1:11434/v1')
  assert.equal(profile.credentialSource, 'none')
  assert.equal(profile.credential(), KEYLESS_CREDENTIAL)
  assert.equal(profile.contextWindow, 32_768)
  assert.equal(profile.maxTokens, 8_192)
  const brain = createBrain(profile)
  assert.equal(brain.providerId, 'openai-compatible')
  assert.equal(brain.model.id, 'qwen-local')
  assert.equal(brain.model.baseUrl, 'http://127.0.0.1:11434/v1')
  assert.equal(brain.model.api, 'openai-completions')
  assert.equal(brain.models.getProviders().length, 1, 'exactly one provider is registered')
  assert.equal(brain.models.getModels().length, 1, 'exactly one model is reachable')
})

test('official providers resolve only catalog models at the official endpoint and register a single provider', () => {
  const openai = createBrain(parse({ provider: 'openai', model: 'gpt-5.6-luna', apiKey: SECRET }))
  assert.equal(openai.providerId, 'openai')
  assert.equal(openai.model.id, 'gpt-5.6-luna')
  assert.equal(openai.model.baseUrl, 'https://api.openai.com/v1')
  assert.equal(openai.models.getProviders().length, 1)
  assert.ok(!JSON.stringify(openai.models.getProviders().map(provider => ({ id: provider.id, baseUrl: provider.baseUrl }))).includes(SECRET))
  const anthropic = createBrain(parse({ provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: SECRET }))
  assert.equal(anthropic.providerId, 'anthropic')
  assert.equal(anthropic.model.api, 'anthropic-messages')
  assert.throws(() => createBrain(parse({ provider: 'openai', model: 'gpt-nonexistent-model', apiKey: SECRET })), (error: unknown) => error instanceof BrainProfileError && error.code === 'unsupported' && /カタログ/u.test(error.message))
  assert.throws(() => createBrain(parse({ provider: 'anthropic', model: 'claude-nonexistent', apiKey: SECRET })), (error: unknown) => error instanceof BrainProfileError && error.code === 'unsupported')
})

test('provider auth resolves only from the profile: never from ambient OPENAI_API_KEY', async () => {
  const withKey = createBrain(parse({ provider: 'openai', model: 'gpt-5.6-luna', apiKey: SECRET }))
  const resolved = await withKey.models.getAuth('openai')
  assert.equal(resolved?.auth.apiKey, SECRET)
  const keyless = createBrain(parse({ provider: 'openai-compatible', model: 'local', baseUrl: 'http://127.0.0.1:1/v1' }))
  const none = await keyless.models.getAuth('openai-compatible')
  assert.ok(none, 'a keyless local endpoint is still a configured provider')
  assert.equal(none?.auth.apiKey, KEYLESS_CREDENTIAL, 'keyless endpoints get the fixed non-secret placeholder Pi requires')
})

test('settings file lifecycle: missing -> template created once -> loaded from the launcher path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-brain-settings-'))
  try {
    const path = join(root, 'Misen', 'config', 'settings.json')
    await assert.rejects(loadBrainProfile(path), (error: unknown) => error instanceof BrainProfileError && error.code === 'missing' && error.message.includes(path))
    assert.equal(await ensureSettingsTemplate(path), 'created')
    assert.equal(await readFile(path, 'utf8'), SETTINGS_TEMPLATE)
    await writeFile(path, settings({ provider: 'openai', model: 'gpt-5.6-luna', apiKey: SECRET }), 'utf8')
    assert.equal(await ensureSettingsTemplate(path), 'exists', 'an existing file is never overwritten')
    const profile = await loadBrainProfile(path)
    assert.equal(profile.credential(), SECRET)
    await writeFile(path, `\uFEFF${settings({ provider: 'openai', model: 'gpt-5.6-luna', apiKey: SECRET })}`, 'utf8')
    assert.equal((await loadBrainProfile(path)).model, 'gpt-5.6-luna', 'a UTF-8 BOM written by Notepad is tolerated')
    await stat(path)
    assert.equal(defaultSettingsPath({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }), 'C:\\Users\\me\\AppData\\Local\\Misen\\config\\settings.json')
    assert.equal(defaultSettingsPath({ MISEN_SETTINGS_PATH: path }), path)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('JSONC comments are stripped outside strings only', () => {
  assert.equal(stripJsonComments('{"a": "http://x//y", /* c */ "b": 1 // tail\n}'), '{"a": "http://x//y",  "b": 1 \n}')
  assert.equal(stripJsonComments('{"q": "a\\"b//c"}'), '{"q": "a\\"b//c"}')
})
