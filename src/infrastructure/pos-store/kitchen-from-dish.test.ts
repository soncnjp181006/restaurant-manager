import { describe, expect, it } from 'vitest';
import { kitchenStagesFromDish } from './kitchen-from-dish';
import { OrderItemKitchenStatus } from '@/api/model/order_item_kitchen';

/**
 * Kitchen routing decides whether sending an order to the kitchen produces any
 * `order_item_kitchen` rows at all. It has two documented paths:
 *   1. workflow dishes  → one row per stage (first pending, rest waiting)
 *   2. legacy routing   → one terminal pending row per kitchen listing the dish
 * A dish with neither produces no rows, which looks like "KOT silently missing"
 * on the floor — pin all three behaviours.
 */
const dish = (overrides: Record<string, unknown> = {}) => ({ id: 'menu_item:coffee', ...overrides }) as never;
const kitchen = (id: string, itemIds: string[], deleted = false) =>
  ({ id: `kitchen:${id}`, items: itemIds.map((item) => ({ id: item })), deleted_at: deleted ? '2026-01-01T00:00:00Z' : null }) as never;

describe('kitchenStagesFromDish', () => {
  it('maps every workflow stage, pending first then waiting', () => {
    const stages = kitchenStagesFromDish(
      dish({
        workflow: {
          id: 'workflow:w1',
          stages: [
            { id: 'workflow_stage:s1', sequence: 1, name: 'Prep', kitchen: { id: 'kitchen:k1' }, is_terminal: false },
            { id: 'workflow_stage:s2', sequence: 2, name: 'Cook', kitchen: { id: 'kitchen:k2' }, is_terminal: true },
          ],
        },
      }),
      [],
    );

    expect(stages).toEqual([
      {
        kitchenId: 'kitchen:k1',
        sequence: 1,
        isTerminal: false,
        workflowId: 'workflow:w1',
        stageId: 'workflow_stage:s1',
        stageName: 'Prep',
        status: OrderItemKitchenStatus.Pending,
      },
      {
        kitchenId: 'kitchen:k2',
        sequence: 2,
        isTerminal: true,
        workflowId: 'workflow:w1',
        stageId: 'workflow_stage:s2',
        stageName: 'Cook',
        status: OrderItemKitchenStatus.Waiting,
      },
    ]);
  });

  it('honours a per-dish stage override kitchen', () => {
    const stages = kitchenStagesFromDish(
      dish({
        workflow: {
          id: 'workflow:w1',
          stages: [{ id: 'workflow_stage:s1', sequence: 1, name: 'Prep', kitchen: { id: 'kitchen:k1' }, is_terminal: true }],
        },
        stage_overrides: { 'workflow_stage:s1': { id: 'kitchen:k9' } },
      }),
      [],
    );
    expect(stages?.[0]?.kitchenId).toBe('kitchen:k9');
  });

  it('falls back to kitchens that list the dish when there is no workflow', () => {
    const stages = kitchenStagesFromDish(dish(), [
      kitchen('k1', ['menu_item:coffee']),
      kitchen('k2', ['menu_item:other']),
      kitchen('k3', ['menu_item:coffee'], true),
    ]);
    expect(stages).toEqual([
      { kitchenId: 'kitchen:k1', sequence: 0, isTerminal: true, status: OrderItemKitchenStatus.Pending },
    ]);
  });

  it('produces nothing when the dish matches no kitchen', () => {
    expect(kitchenStagesFromDish(dish(), [kitchen('k2', ['menu_item:other'])])).toEqual([]);
  });
});
