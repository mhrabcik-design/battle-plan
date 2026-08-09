import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    validateCapability,
    validateCommand,
    validateDriveReceipt,
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
    'drive-receipt': validateDriveReceipt,
};

async function load(relativePath) {
    return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
}

let assertions = 0;
for (const name of (await readdir(path.join(root, 'fixtures/valid'))).filter((entry) => entry.endsWith('.json')).sort()) {
    const fixture = await load(`fixtures/valid/${name}`);
    const type = fixture.signed?.message_type;
    const validator = validators[type];
    if (!validator) throw new Error(`valid/${name} has unregistered message type ${String(type)}`);
    if (!validator(fixture)) {
        throw new Error(`valid/${name} failed: ${JSON.stringify(validator.errors)}`);
    }
    assertions++;
}

for (const name of (await readdir(path.join(root, 'fixtures/invalid'))).filter((entry) => entry.endsWith('.json'))) {
    const fixture = await load(`fixtures/invalid/${name}`);
    const cases = fixture.cases ?? [{ name, message: fixture.message }];
    for (const invalidCase of cases) {
        const type = invalidCase.message?.signed?.message_type;
        const validator = validators[type] ?? validateHello;
        const schemaValid = validator(invalidCase.message);
        if (invalidCase.validation_layer === 'semantic') {
            if (!schemaValid) throw new Error(`invalid/${name}/${invalidCase.name} must reach semantic validation: ${JSON.stringify(validator.errors)}`);
        } else if (schemaValid) {
            throw new Error(`invalid/${name}/${invalidCase.name} unexpectedly validated`);
        }
        assertions++;
    }
}

console.log(`BattlePlan-Hermes v2 source-independent schema conformance: ${assertions} fixtures passed.`);
