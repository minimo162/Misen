import { runJulyMonthDiagnosis } from './live-brain.js'

const result = await runJulyMonthDiagnosis()
if (result.status === 'FAIL') process.exitCode = 1
