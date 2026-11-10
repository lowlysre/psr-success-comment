import * as core from '@actions/core'
import { errorMessage, readInputs, run } from './main.ts'

// run() reports its own failures; this catches readInputs(), such as a missing required input.
try {
  void run(readInputs())
} catch (err) {
  core.setFailed(errorMessage(err))
}
