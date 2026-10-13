import { test } from './harness/fixtures.ts';
import { reducedMotionFlow } from './reduced-motion.shared.ts';

test.use({ ccOptions: { server: 'reduced-motion' } });

test('reduced motion keeps the working indicator visible but stops its animation', reducedMotionFlow);
