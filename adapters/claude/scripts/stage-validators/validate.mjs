#!/usr/bin/env node
import { stageValidatorCli } from '../lib/stage-validation.mjs';
process.exitCode = stageValidatorCli('validate');
