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
      <div className={
        cn("pl-x flex justify-between", item.isModifier ? 'text-sm' : '')
      } style={{
        '--padding': (item.level * 0.875) + 'rem'
      } as any}>
        <span className="text-ellipsis line-clamp-1">{item.dish.name}</span>
        <div className={
          cn(
            // Sized for grouped currency ("₫45,000") — the old 40px clipped it.
            showTotalInCart ? "grid grid-cols-2 gap-2 w-[110px] text-right" : "grid grid-cols-1 w-[64px] text-right"
          )
        }>
          <span>{withCurrency(item.price)}</span>
          {showTotalInCart && (
            <span>{withCurrency(item.price * mainItem.quantity)}</span>
          )}
        </div>
      </div>
      {item.comments && (
        <div className="italic text-sm">({item.comments})</div>
      )}
      {item?.selectedGroups?.map(group =>
        <div className="border-[3px] border-l-warning border-r-0 border-y-0 mb-2" key={group.out?.id}>
          {group?.selectedModifiers?.map(modifier => (
            <CartItemName key={modifier.id} item={modifier} mainItem={mainItem} />
          ))}
        </div>
      )}
    </>
  )
}
