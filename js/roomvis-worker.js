// Worker for room visibility: { grid, tiles: [[room, x, y, eyes(Float64Array)]…] }
// posts { type: 'tiles', items: [[room, x, y, [ids seen]]…] } in batches, then { type: 'done' }
import { seenFrom } from './roomvis.js?v=2';

self.onmessage = (ev) => {
  const { grid, tiles } = ev.data;
  let batch = [], t = performance.now();
  for (const [room, x, y, eyes] of tiles) {
    batch.push([room, x, y, [...seenFrom(grid, eyes)]]);
    if (performance.now() - t > 250) { self.postMessage({ type: 'tiles', items: batch }); batch = []; t = performance.now(); }
  }
  self.postMessage({ type: 'tiles', items: batch });
  self.postMessage({ type: 'done' });
};
