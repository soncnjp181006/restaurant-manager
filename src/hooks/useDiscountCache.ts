import { useEffect } from 'react'
import { buildDiscountCache } from '@/lib/discount-engine/cache.ts'
import { loadActiveDiscountRules } from '@/lib/discount-engine/service.ts'

let initPromise: Promise<void> | null = null

export const refreshDiscountCache = async (): Promise<void> => {
  const rules = await loadActiveDiscountRules()
  buildDiscountCache(rules)
}

/**
 * Keep the in-memory discount cache in sync with the local PosStore catalog.
 * Never depends on Surreal `db.live('discount')` — offline/online identical.
 */
export const useDiscountCache = () => {
  useEffect(() => {
    if (!initPromise) {
      initPromise = refreshDiscountCache().catch(() => {
        initPromise = null
      })
    }

    const onLocalWrite = () => {
      void refreshDiscountCache()
    }
    window.addEventListener('restaurant-manager-posstore-write', onLocalWrite)
    void refreshDiscountCache()

    return () => {
      window.removeEventListener('restaurant-manager-posstore-write', onLocalWrite)
    }
  }, [])
}
