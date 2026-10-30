import { createStore } from 'idb-keyval';

// Use dedicated database names. The shared browser DB from before the rename was already
// created with only the `jotai-storage` object store; adding new stores to it requires
// a version bump that idb-keyval does not perform on existing databases.
export const integrationQueueStore = createStore('restaurant-manager-integration-queue', 'keyval');
export const integrationSecretsStore = createStore('restaurant-manager-integration-secrets', 'keyval');
