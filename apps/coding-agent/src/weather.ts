export interface WeatherLocation {
  name: string
  latitude: number
  longitude: number
  country?: string
  admin1?: string
}

interface GeocodingResponse {
  results?: Array<{
    name?: unknown
    latitude?: unknown
    longitude?: unknown
    country?: unknown
    admin1?: unknown
  }>
}

interface ForecastResponse {
  timezone?: unknown
  current?: {
    time?: unknown
    temperature_2m?: unknown
    apparent_temperature?: unknown
    weather_code?: unknown
  }
  daily?: {
    time?: unknown
    temperature_2m_max?: unknown
    temperature_2m_min?: unknown
    weather_code?: unknown
  }
}

export interface WeatherFetcher {
  (input: string, init?: RequestInit): Promise<Response>
}

export interface WeatherResult {
  location: WeatherLocation
  timezone: string
  time: string
  temperatureC: number
  apparentTemperatureC?: number
  weatherCode: number
  maxTemperatureC?: number
  minTemperatureC?: number
  dailyWeatherCode?: number
}

const DEFAULT_FETCH_TIMEOUT_MS = 15_000

function finiteNumber(value: unknown, label: string): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) throw new Error(`天気APIの${label}が不正です`)
  return n
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return finiteNumber(value, label)
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`天気APIの${label}がありません`)
  return value.trim()
}

async function fetchJson<T>(url: string, signal: AbortSignal | undefined, fetcher: WeatherFetcher): Promise<T> {
  const timeout = AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS)
  const controller = new AbortController()
  const abort = () => controller.abort()
  timeout.addEventListener('abort', abort, { once: true })
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetcher(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`天気APIがHTTP ${response.status}を返しました`)
    try {
      return (await response.json()) as T
    } catch {
      throw new Error('天気APIの応答がJSONではありません')
    }
  } catch (err) {
    if (signal?.aborted) throw new Error('天気取得はキャンセルされました')
    if (controller.signal.aborted) throw new Error('天気APIがタイムアウトしました')
    throw err
  } finally {
    timeout.removeEventListener('abort', abort)
    signal?.removeEventListener('abort', abort)
  }
}

export function weatherCodeLabel(code: number): { emoji: string; label: string } {
  if (code === 0) return { emoji: '☀️', label: '快晴' }
  if (code === 1) return { emoji: '🌤️', label: '主に晴れ' }
  if (code === 2) return { emoji: '⛅', label: '晴れ時々曇り' }
  if (code === 3) return { emoji: '☁️', label: '曇り' }
  if (code === 45 || code === 48) return { emoji: '🌫️', label: '霧' }
  if (code >= 51 && code <= 57) return { emoji: '🌦️', label: '霧雨' }
  if (code >= 61 && code <= 67) return { emoji: '🌧️', label: '雨' }
  if (code >= 71 && code <= 77) return { emoji: '❄️', label: '雪' }
  if (code >= 80 && code <= 82) return { emoji: '🌦️', label: 'にわか雨' }
  if (code === 85 || code === 86) return { emoji: '🌨️', label: 'にわか雪' }
  if (code === 95 || code === 96 || code === 99) return { emoji: '⛈️', label: '雷雨' }
  return { emoji: '🌡️', label: '天気情報' }
}

function locationText(location: WeatherLocation): string {
  const details = [location.admin1, location.country].filter(Boolean)
  return details.length > 0 ? `${location.name}（${details.join('・')}）` : location.name
}

export function formatWeather(result: WeatherResult): string {
  const current = weatherCodeLabel(result.weatherCode)
  const daily = result.dailyWeatherCode === undefined ? undefined : weatherCodeLabel(result.dailyWeatherCode)
  const place = locationText(result.location)
  const lines = [
    `${place}`,
    `現在: ${result.temperatureC.toFixed(1)}°C${result.apparentTemperatureC === undefined ? '' : `（体感 ${result.apparentTemperatureC.toFixed(1)}°C）`}`,
    `天気: ${current.emoji} ${current.label}`,
    `今日: 最高 ${result.maxTemperatureC === undefined ? '不明' : `${result.maxTemperatureC.toFixed(1)}°C`} / 最低 ${result.minTemperatureC === undefined ? '不明' : `${result.minTemperatureC.toFixed(1)}°C`}${daily ? `（${daily.emoji} ${daily.label}）` : ''}`,
    `取得時刻: ${result.time} (${result.timezone})`,
    '出典: Open-Meteo（予報モデルの現在値）'
  ]
  return lines.join('\n')
}

export async function getWeather(
  locationName: string,
  signal?: AbortSignal,
  fetcher: WeatherFetcher = (input, init) => fetch(input, init)
): Promise<string> {
  const location = locationName.trim()
  if (!location) throw new Error('地域名が必要です（例: 広島市）')

  const geocodeUrl = new URL('https://geocoding-api.open-meteo.com/v1/search')
  geocodeUrl.search = new URLSearchParams({ name: location, count: '1', language: 'ja', format: 'json' }).toString()
  const geocoding = await fetchJson<GeocodingResponse>(geocodeUrl.toString(), signal, fetcher)
  const match = geocoding.results?.[0]
  if (!match) throw new Error(`地域が見つかりません: ${location}`)
  const resolved: WeatherLocation = {
    name: stringValue(match.name, '地域名'),
    latitude: finiteNumber(match.latitude, '緯度'),
    longitude: finiteNumber(match.longitude, '経度'),
    ...(typeof match.country === 'string' && match.country ? { country: match.country } : {}),
    ...(typeof match.admin1 === 'string' && match.admin1 ? { admin1: match.admin1 } : {})
  }

  const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast')
  forecastUrl.search = new URLSearchParams({
    latitude: String(resolved.latitude),
    longitude: String(resolved.longitude),
    current: 'temperature_2m,apparent_temperature,weather_code',
    daily: 'temperature_2m_max,temperature_2m_min,weather_code',
    timezone: 'auto',
    forecast_days: '1'
  }).toString()
  const forecast = await fetchJson<ForecastResponse>(forecastUrl.toString(), signal, fetcher)
  const current = forecast.current
  if (!current) throw new Error('天気APIに現在値がありません')
  const daily = forecast.daily
  const timezone = stringValue(forecast.timezone, 'タイムゾーン')
  const time = stringValue(current.time, '取得時刻')
  return formatWeather({
    location: resolved,
    timezone,
    time,
    temperatureC: finiteNumber(current.temperature_2m, '現在気温'),
    apparentTemperatureC: optionalFiniteNumber(current.apparent_temperature, '体感気温'),
    weatherCode: finiteNumber(current.weather_code, '現在天気コード'),
    maxTemperatureC: Array.isArray(daily?.temperature_2m_max) ? optionalFiniteNumber(daily.temperature_2m_max[0], '最高気温') : undefined,
    minTemperatureC: Array.isArray(daily?.temperature_2m_min) ? optionalFiniteNumber(daily.temperature_2m_min[0], '最低気温') : undefined,
    dailyWeatherCode: Array.isArray(daily?.weather_code) ? optionalFiniteNumber(daily.weather_code[0], '日別天気コード') : undefined
  })
}
