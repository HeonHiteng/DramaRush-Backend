import { describe, expect, it } from 'vitest';
import { accessFor, matchEpisodeFiles, parseNumberList, slugify, SERIES_ID_RE } from './episodes';
import { budgetLevel, deliveryCost, storageCost } from './costs';
const f = (name) => ({ name });
describe('matchEpisodeFiles', () => {
    it('maps common episode file names to numbers, sorted', () => {
        const r = matchEpisodeFiles([f('ep10.mp4'), f('EP 2.mov'), f('episode-3.mkv'), f('004.mp4'), f('Ep_1.webm')]);
        expect(r.matched.map((m) => m.number)).toEqual([1, 2, 3, 4, 10]);
        expect(r.unmatched).toHaveLength(0);
    });
    it('keeps folder paths working and reports junk and duplicates', () => {
        const r = matchEpisodeFiles([f('series/ep01.mp4'), f('ep1.mp4'), f('poster.jpg'), f('trailer.mp4'), f('ep0.mp4')]);
        expect(r.matched).toEqual([{ number: 1, file: { name: 'series/ep01.mp4' } }]);
        expect(r.duplicates).toEqual([1]);
        expect(r.unmatched.map((x) => x.name)).toEqual(['poster.jpg', 'trailer.mp4', 'ep0.mp4']);
    });
});
describe('paywall rules', () => {
    it('parses lists and ranges', () => {
        expect(parseNumberList('4, 6-8，10')).toEqual([4, 6, 7, 8, 10]);
        expect(parseNumberList('  ')).toEqual([]);
        expect(() => parseNumberList('4,x')).toThrow();
    });
    it('first N free, listed episodes ad-unlock, rest coins or members', () => {
        const rule = { freeCount: 3, adUnlock: [4, 6], rest: 'coin', coinPrice: 20 };
        expect(accessFor(1, rule)).toEqual({ access: 'free', coinPrice: null });
        expect(accessFor(4, rule)).toEqual({ access: 'ad_unlock', coinPrice: null });
        expect(accessFor(5, rule)).toEqual({ access: 'coin', coinPrice: 20 });
        expect(accessFor(5, { ...rule, rest: 'subscriber' })).toEqual({ access: 'subscriber', coinPrice: null });
    });
});
describe('slugify', () => {
    it('makes valid series ids', () => {
        expect(slugify('Crimson Contract')).toBe('crimson-contract');
        expect(slugify("The Understudy's Revenge!")).toBe('the-understudy-s-revenge');
        expect(SERIES_ID_RE.test(slugify('Café Noir 2'))).toBe(true);
    });
});
describe('costs', () => {
    it('estimates delivery and storage', () => {
        expect(deliveryCost(9000)).toBeCloseTo(9);
        expect(storageCost(0)).toBe(5);
        expect(storageCost(1000)).toBe(5);
        expect(storageCost(1001)).toBe(10);
    });
    it('matches the server budget levels', () => {
        expect(budgetLevel(500, 0, 0.8)).toBe('off');
        expect(budgetLevel(79, 100, 0.8)).toBe('ok');
        expect(budgetLevel(80, 100, 0.8)).toBe('soft');
        expect(budgetLevel(100, 100, 0.8)).toBe('hard');
    });
});
