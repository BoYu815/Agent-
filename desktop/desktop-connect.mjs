import { controlPanelUrl } from './backend/src/client.mjs';
import { redact } from './backend/src/common.mjs';

try {
  process.stdout.write(await controlPanelUrl());
} catch (error) {
  process.stderr.write(redact(error.message));
  process.exitCode = 1;
}
