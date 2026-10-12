import { test } from './harness/fixtures.ts';
import { projectsFlow, regroupFlow } from './sidebar-api-projects.shared.ts';

test.use({ ccOptions: { server: 'sidebar-api-projects' } });

test('projects created and deleted through the API after load show and go without a reload', projectsFlow);
test('a worktree, a workspace assignment and a workspace rename made through MCP after load show without a reload', regroupFlow);
