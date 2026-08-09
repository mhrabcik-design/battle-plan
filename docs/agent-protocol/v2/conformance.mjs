import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    validateCapability,
    validateCommand,
    validateEventBatch,
    validateHello,
    validateProposal,
    validateResponse,
    validateResult,
    validateSnapshot,
} from './generated-validators.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const validators = {
    hello: validateHello,
    capability: validateCapability,
    command: validateCommand,
    result: validateResult,
    'event-batch': validateEventBatch,
    snapshot: validateSnapshot,
    proposal: validateProposal,
    response: validateResponse,
};

async function load(relativePath) {
    return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
}

let assertions = 0;
for (const [type, validator] of Object.entries(validators)) {
    const fixture = await load(`fixtures/valid/${type}.json`);
    if (!validator(fixture)) {
        throw new Error(`valid/${type}.json failed: ${JSON.stringify(validator.errors)}`);
    }
    assertions++;
}

for (const name of (await readdir(path.join(root, 'fixtures/invalid'))).filter((entry) => entry.endsWith('.json'))) {
    const fixture = await load(`fixtures/invalid/${name}`);
    const type = fixture.message?.signed?.message_type;
    const validator = validators[type] ?? validateHello;
    if (validator(fixture.message)) throw new Error(`invalid/${name} unexpectedly validated`);
    assertions++;
}

console.log(`BattlePlan-Hermes v2 source-independent schema conformance: ${assertions} fixtures passed.`);
