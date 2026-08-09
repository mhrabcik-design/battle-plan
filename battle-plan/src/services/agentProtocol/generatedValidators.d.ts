// Generated declaration for CSP-safe standalone validators.
import type { ErrorObject } from 'ajv';
export interface ProtocolStandaloneValidator {
    (data: unknown): boolean;
    errors?: ErrorObject[] | null;
}
export const validateHello: ProtocolStandaloneValidator;
export const validateCapability: ProtocolStandaloneValidator;
export const validateCommand: ProtocolStandaloneValidator;
export const validateResult: ProtocolStandaloneValidator;
export const validateEventBatch: ProtocolStandaloneValidator;
export const validateSnapshot: ProtocolStandaloneValidator;
export const validateProposal: ProtocolStandaloneValidator;
export const validateResponse: ProtocolStandaloneValidator;
