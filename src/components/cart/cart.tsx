import React, {useMemo} from "react";
import {Button} from "@/components/common/input/button.tsx";
import {faReceipt, faTrash} from "@fortawesome/free-solid-svg-icons";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {useAtom} from "jotai";
import {appState} from "@/store/jotai.ts";
import ScrollContainer from "react-indiana-drag-scroll";
import {CartItem} from "@/components/cart/cart.item.tsx";
import {Payment} from "@/components/payment/payment.tsx";
import {Seats} from "@/components/cart/seats.tsx";
import {CartActions} from "@/components/cart/cart.actions.tsx";
import {MenuItemType} from "@/api/model/cart_item.ts";
import {useTranslation} from "react-i18next";

export const MenuCart = () => {
  const [state, setState] = useAtom(appState);
  const { t } = useTranslation('cart');

  const cartItems = useMemo(() => {
    return state.cart.filter(item => item.seat === state.seat);
  }, [state.cart, state.seat]);

  const isSelected = useMemo(() => {
    return state.cart.find(item => item.isSelected) !== undefined;
  }, [state.cart]);

  const newItems = useMemo(() => {
    return cartItems.filter(item => item.newOrOld === MenuItemType.new);
  }, [cartItems]);

  const oldItems = useMemo(() => {
    return cartItems.filter(item => item.newOrOld === MenuItemType.old);
  }, [cartItems]);

  const totalLines = state.cart.length;
  const isEmpty = totalLines === 0;

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="cart-panel">
      <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-[15px] font-semibold">{t('title')}</h2>
          {totalLines > 0 && (
            <span className="rounded-md bg-surface px-1.5 py-0.5 text-[11.5px] font-medium text-muted tnum">
              {totalLines}
            </span>
          )}
        </div>
      </div>

      <div className="flex-shrink-0 px-3 pt-2.5" data-testid="cart-seats-or-actions">
        {isSelected ? (
          <CartActions/>
        ) : (
          <Seats/>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-2 pb-1" data-testid="cart-items">
        {state.seat && cartItems.length === 0 && state.seats.length > 0 && (
          <div className="flex h-[72px] items-center justify-center">
            <Button variant="danger" icon={faTrash} onClick={() => {
              setState(prev => ({
                ...prev,
                seats: prev.seats.filter(s => s !== state.seat),
              }));
              setState(prev => ({
                ...prev,
                seat: prev.seats.at(-1)
              }))
            }}>{t('seats.deleteSeat')}</Button>
          </div>
        )}

        {isEmpty ? (
          <div className="empty-state">
            <span className="empty-state-icon">
              <FontAwesomeIcon icon={faReceipt} />
            </span>
            <p className="text-[13.5px] font-medium text-foreground">{t('empty.title')}</p>
            <p className="max-w-[220px] text-[12.5px] leading-relaxed">{t('empty.hint')}</p>
          </div>
        ) : (
          <ScrollContainer className="cart-list clean-scroll flex h-full select-none flex-col overflow-y-auto">
            {newItems.length > 0 && (
              <p className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted">{t('newLines')}</p>
            )}
            {newItems.map((item) => (
              <CartItem item={item} key={item.id}/>
            ))}
            {newItems.length > 0 && oldItems.length > 0 && (
              <div className="mx-2 my-2 h-px bg-border"></div>
            )}
            {oldItems.length > 0 && (
              <p className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted">{t('sentLines')}</p>
            )}
            {oldItems.map((item) => (
              <CartItem item={item} key={item.id}/>
            ))}
          </ScrollContainer>
        )}
      </div>

      <div className="flex-shrink-0 border-t border-border px-4 py-3" data-testid="cart-payment">
        <Payment/>
      </div>
    </div>
  );
}
