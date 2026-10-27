/* node tests/build-and-run.js — concatenates core + logic + seed + the scenario tests and runs them headless */
const fs = require('fs'), path = require('path'), vm = require('vm');
const dir = path.join(__dirname, '..', 'js');
const src = ['core.js', 'logic.js', 'advances.js', 'seed.js'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n') + '\n' + fs.readFileSync(path.join(__dirname, 'scenarios.test.js'), 'utf8');
vm.runInNewContext(src, { console, Date, Math, JSON, Number, String, Array, Set, Object, Intl });
/* edge-case suite (PRD v1.3 section 5) runs in its own context */
const edge = ['core.js', 'logic.js', 'advances.js', 'seed.js'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join(String.fromCharCode(10)) + String.fromCharCode(10) + fs.readFileSync(path.join(__dirname, 'edge.test.js'), 'utf8');
vm.runInNewContext(edge, { console, Date, Math, JSON, Number, String, Array, Set, Object, Intl });
const spec = ['core.js', 'logic.js', 'advances.js', 'seed.js'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join(String.fromCharCode(10)) + String.fromCharCode(10) + fs.readFileSync(path.join(__dirname, 'spec.test.js'), 'utf8');
vm.runInNewContext(spec, { console, Date, Math, JSON, Number, String, Array, Set, Object, Intl });
const deps = ['core.js', 'logic.js', 'advances.js', 'seed.js'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join(String.fromCharCode(10)) + String.fromCharCode(10) + fs.readFileSync(path.join(__dirname, 'deps.test.js'), 'utf8');
vm.runInNewContext(deps, { console, Date, Math, JSON, Number, String, Array, Set, Object, Intl });
const link = ['core.js', 'logic.js', 'advances.js', 'seed.js'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join(String.fromCharCode(10)) + String.fromCharCode(10) + fs.readFileSync(path.join(__dirname, 'link.test.js'), 'utf8');
vm.runInNewContext(link, { console, Date, Math, JSON, Number, String, Array, Set, Object, Intl });
