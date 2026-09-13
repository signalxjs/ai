import { describe, it, expect } from 'vitest';
import { allowAll, denyAll, allowReadOnly, allowTools, denyTools, firstMatch, rule, createGrants, type PolicyContext, type PolicyRequest } from '@sigx/ai-agent';

const ctx: PolicyContext = { sessionId: 's', interactive: true, grants: createGrants(), signal: new AbortController().signal };
const perm = (toolName: string, extra: Partial<PolicyRequest> = {}): PolicyRequest => ({ kind: 'permission', toolName, source: 'client', ...extra });
const input: PolicyRequest = { kind: 'input', source: 'native' };

describe('built-in policies', () => {
    it('allowAll allows permissions and has no opinion on input', async () => {
        expect(await allowAll(perm('x'), ctx)).toEqual({ type: 'permission', outcome: 'allow', scope: 'once' });
        expect(await allowAll(input, ctx)).toBeUndefined();
        expect(allowAll.id).toBe('allowAll');
    });

    it('denyAll denies with a message and cancels input', async () => {
        expect(await denyAll(perm('x'), ctx)).toMatchObject({ type: 'permission', outcome: 'deny', message: expect.stringContaining('"x"') });
        expect(await denyAll(input, ctx)).toEqual({ type: 'cancel' });
    });

    it('allowReadOnly uses annotations', async () => {
        expect(await allowReadOnly(perm('read', { annotations: { readOnly: true } }), ctx)).toMatchObject({ outcome: 'allow' });
        expect(await allowReadOnly(perm('write', { annotations: { destructive: true } }), ctx)).toBeUndefined();
        expect(await allowReadOnly(perm('unknown'), ctx)).toBeUndefined();
    });

    it('allowTools / denyTools match by name only', async () => {
        expect(await allowTools(['a'])(perm('a'), ctx)).toMatchObject({ outcome: 'allow' });
        expect(await allowTools(['a'])(perm('b'), ctx)).toBeUndefined();
        expect(await denyTools(['b'])(perm('b'), ctx)).toMatchObject({ outcome: 'deny' });
        expect(await denyTools(['b'])(perm('a'), ctx)).toBeUndefined();
    });

    it('firstMatch takes the first opinion and tags it with the rule id', async () => {
        const policy = firstMatch(allowReadOnly, denyTools(['rm']), rule('custom', () => 'ask'));
        expect(await policy(perm('ls', { annotations: { readOnly: true } }), ctx)).toMatchObject({ outcome: 'allow', ruleId: 'allowReadOnly' });
        expect(await policy(perm('rm'), ctx)).toMatchObject({ outcome: 'deny', ruleId: 'denyTools' });
        expect(await policy(perm('edit'), ctx)).toBe('ask');
        expect(await firstMatch()(perm('x'), ctx)).toBe('ask');
    });

    it('an anonymous rule in firstMatch gets a positional id', async () => {
        const policy = firstMatch(() => undefined, () => ({ type: 'permission', outcome: 'allow', scope: 'session' }));
        expect(await policy(perm('x'), ctx)).toMatchObject({ scope: 'session', ruleId: 'rule1' });
    });
});
