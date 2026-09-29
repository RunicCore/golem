import { saveProjectAccessOverHttp } from './http.js';
import { runHomeDemo } from './home-demo.js';

const example = await runHomeDemo();
console.info('showcase: can write', example.before);
console.info('showcase: can write after grant', example.after);
console.info('showcase: wire', example.wire);
const access = example.access;

console.info('showcase: permission error', example.customFailure);

const baseUrl = process.env.PROJECT_ACCESS_API_BASE_URL;
if (baseUrl) {
  const response = await saveProjectAccessOverHttp(baseUrl, 'project-ops', access);
  console.info('showcase: HTTP response', response.body);
}
