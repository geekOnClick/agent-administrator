import 'dotenv/config';
import { selectEntrypoint } from './entrypoint/selector.js';

selectEntrypoint().then((entrypoint) => {
  entrypoint.run();
});
