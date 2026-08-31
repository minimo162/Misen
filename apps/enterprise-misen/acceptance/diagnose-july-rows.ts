import { runJulyRowsDiagnosis } from './live-brain.js'

const result = await runJulyRowsDiagnosis()
if (result.status === 'FAIL') process.exitCode = 1
