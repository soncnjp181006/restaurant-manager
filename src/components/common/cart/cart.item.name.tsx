import {MenuItem} from "@/api/model/cart_item.ts";
import {cn, withCurrency} from "@/lib/utils.ts";
import React from "react";
import {useAtom} from "jotai";
import {appPage} from "@/store/jotai.ts";

interface Props {
  item: MenuItem
  index: number
  mainItem: MenuItem
}

export const CartItemName = ({ item, mainItem }: Omit<Props, "index">) => {
  const [pageState] = useAtom(appPage);
  const { showTotalInCart = false } = pageState.menuConfig ?? {};

  return (
    <>
      <div
        className={cn("flex items-start justify-between gap-2 pl-x", item.isModifier ? 'text-[12px] text-muted' : '')}
        style={{
          '--padding': item.isModifier ? '0' : (item.level * 0.875) + 'rem'
        } as any}
      >
        <span className="min-w-0 flex-1 line-clamp-2">{item.dish.name}</span>
        <div className={cn(
          "flex-shrink-0 text-right text-[12.5px] tabular-nums",
          item.isModifier ? "text-muted" : "text-muted",
          // Sized for grouped currency ("₫45,000") — the old 40px clipped it.
          showTotalInCart && !item.isModifier ? "grid grid-cols-2 gap-2 w-[110px]" : "grid grid-cols-1 w-[64px]"
        )}>
          <span>{withCurrency(item.price)}</span>
          {showTotalInCart && (
            <span className="font-semibold text-foreground">{withCurrency(item.price * mainItem.quantity)}</span>
          )}
        </div>
      </div>
      {item.comments && (
        <div className="mt-0.5 text-[12px] leading-snug text-muted">{item.comments}</div>
      )}
      {item?.selectedGroups?.map(group =>
        <div className="mt-1 border-l border-border pl-2" key={group.out?.id}>
          {group?.selectedModifiers?.map(modifier => (
            <CartItemName key={modifier.id} item={modifier} mainItem={mainItem} />
          ))}
        </div>
      )}
    </>
  )
}
