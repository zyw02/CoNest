import {probeRuntime} from '../dist/studio/runtime-probe.mjs';
console.log(JSON.stringify(await probeRuntime(),null,2));
