import test from 'node:test'
import { strict as assert } from 'node:assert'
import {
  verifyProfitFormula,
  verifyStatusFormula,
  verifyTotalFormula,
} from '../src/acceptance/formula.js'

const passes = (run: () => void) => assert.doesNotThrow(run)
const fails = (run: () => void) => assert.throws(run)

test('Decision 441 verifies Profit mechanism by counterfactual semantics', () => {
  passes(() => verifyProfitFormula('=B5-C5', 5, 'B', 'C', 1200, 700))
  passes(() => verifyProfitFormula('=SUM(B5,-C5)', 5, 'B', 'C', 1200, 700))
  passes(() => verifyProfitFormula('=B5+(-C5)', 5, 'B', 'C', 1200, 700))
  fails(() => verifyProfitFormula('=B5+C5', 5, 'B', 'C', 1200, 700))
  fails(() => verifyProfitFormula('=B5-C5+A1', 5, 'B', 'C', 1200, 700))
  fails(() => verifyProfitFormula('=B5-C5+0*A1', 5, 'B', 'C', 1200, 700))
  fails(() => verifyProfitFormula('=IF(B5=1200,0,B5-C5)', 5, 'B', 'C', 1200, 700))
  fails(() => verifyProfitFormula("='[outside.xlsx]Sheet1'!B5-C5", 5, 'B', 'C', 1200, 700))
})

test('Decision 441 accepts literal-equivalent Status formula semantics', () => {
  passes(() => verifyStatusFormula('=IF(D5>=400,"On target","Review")', 5, 'D', 'B', 'C', 400, 500))
  passes(() => verifyStatusFormula('=IF(D5<400,"Review","On target")', 5, 'D', 'B', 'C', 400, 500))
  passes(() => verifyStatusFormula('=IF(B5-C5>=400,"On target","Review")', 5, 'D', 'B', 'C', 400, 500))
  fails(() => verifyStatusFormula('=IF(D5>=400,"Review","On target")', 5, 'D', 'B', 'C', 400, 500))
  fails(() => verifyStatusFormula('=IF(D5>=401,"On target","Review")', 5, 'D', 'B', 'C', 400, 500))
  fails(() => verifyStatusFormula('=IF(D6>=400,"On target","Review")', 5, 'D', 'B', 'C', 400, 500))
  fails(() => verifyStatusFormula('=IF(A1=A1,IF(D5>=400,"On target","Review"),"Review")', 5, 'D', 'B', 'C', 400, 500))
  fails(() => verifyStatusFormula('=IF(D5=500,"Review",IF(D5>=400,"On target","Review"))', 5, 'D', 'B', 'C', 400, 500))
  fails(() => verifyStatusFormula("=IF('[outside.xlsx]Sheet1'!D5>=400,\"On target\",\"Review\")", 5, 'D', 'B', 'C', 400, 500))
})

test('Decision 441 verifies Total formulas against all and only company rows', () => {
  passes(() => verifyTotalFormula('=SUM(B5:B7)', 'B', [5, 6, 7], [1200, 950, 1100]))
  passes(() => verifyTotalFormula('=B5+B6+B7', 'B', [5, 6, 7], [1200, 950, 1100]))
  fails(() => verifyTotalFormula('=SUM(B5:B6)', 'B', [5, 6, 7], [1200, 950, 1100]))
  fails(() => verifyTotalFormula('=B5+B6+B6+B7', 'B', [5, 6, 7], [1200, 950, 1100]))
  fails(() => verifyTotalFormula('=SUM(C5:C7)', 'B', [5, 6, 7], [1200, 950, 1100]))
  fails(() => verifyTotalFormula('=SUM(B5:B7)+0*A1', 'B', [5, 6, 7], [1200, 950, 1100]))
  fails(() => verifyTotalFormula('=IF(B5=1200,0,SUM(B5:B7))', 'B', [5, 6, 7], [1200, 950, 1100]))
  fails(() => verifyTotalFormula("=SUM('[outside.xlsx]Sheet1'!B5:B7)", 'B', [5, 6, 7], [1200, 950, 1100]))
  fails(() => verifyTotalFormula('=SUM(A1:XFD1048576)', 'B', [5, 6, 7], [1200, 950, 1100]))
})
