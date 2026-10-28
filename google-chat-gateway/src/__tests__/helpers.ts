import { recordFailure } from '../retry-policy.js';

/** What the retry policy does with a first failure carrying this Google status code. */
export function classify(code: string | undefined): 'park' | 'retry' {
  const err = Object.assign(new Error('x'), { data: { error: code } });
  return recordFailure(undefined, err, 'sig', Date.now(), 1000).action === 'park' ? 'park' : 'retry';
}
