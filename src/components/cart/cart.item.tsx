import React, {useState} from "react";
import {MenuItem, MenuItemType} from "@/api/model/cart_item.ts";
import {useAtom} from "jotai";
import {appState} from "@/store/jotai.ts";
import {cn} from "@/lib/utils.ts";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faMinus, faPencil, faPlus, faTrash, faComment} from "@fortawesome/free-solid-svg-icons";
import {MenuDishModifiers} from "@/components/menu/modifiers.tsx";
import {Input} from "@/components/common/input/input.tsx";
import {VirtualKeyboard} from "@/components/common/input/virtual.keyboard.tsx";
import {CartItemName} from "@/components/common/cart/cart.item.name.tsx";
import {useTranslation} from "react-i18next";

interface Props {
  item: MenuItem
}

export const CartItem = ({ item }: Props) => {
  const { t } = useTranslation(['cart', 'common']);
  const [state, setState] = useAtom(appState);
  const [isModifiersOpen, setModifiersOpen] = useState(false);
  const [isCommentKeyboardOpen, setCommentKeyboardOpen] = useState(false);
  const [commentText, setCommentText] = useState(item.comments || "");

  const removeOrDecrement = () => {
    setState(prev => ({
      ...prev,
      cart: item.quantity <= 1
        ? prev.cart.filter((_item) => _item.id !== item.id)
        : prev.cart.map((_item) => item.id === _item.id
          ? { ..._item, quantity: _item.quantity - 1 }
          : _item),
    }));
  };

  return (
    <>
      <div
        className="cart-line cursor-pointer select-none px-2 py-2 text-foreground"
        data-selected={item.isSelected ? 'true' : undefined}
        data-hold={item.isHold ? 'true' : undefined}
        onClick={() => {
          if(item.deleted_at === undefined && (item.newOrOld === 'new' || item.isHold)) {
            setState(prev => ({
              ...prev,
              cart: prev.cart.map(ci => {
                if (ci.id === item.id) {
                  ci.isSelected = !ci.isSelected;
                }

                return ci
              })
            }))
          }
        }}
      >
        <div className="flex items-start gap-2.5">
          {item.newOrOld === MenuItemType.new ? (
            <div className="qty-stepper flex-shrink-0" onClick={(event) => event.stopPropagation()}>
              <button
                type="button"
                aria-label={item.quantity <= 1 ? t('common:actions.remove') : t('common:actions.remove')}
                onClick={removeOrDecrement}
              >
                <FontAwesomeIcon icon={item.quantity <= 1 ? faTrash : faMinus} className="text-[10px]" />
              </button>
              <Input
                type="number"
                enableKeyboard
                aria-label={t('common:actions.quantity', { defaultValue: 'Quantity' })}
                value={item.quantity}
                onChange={(e) => {
                  setState(prev => ({
                    ...prev,
                    cart: prev.cart.map((_item) => {
                      if( item.id === _item.id ) {
                        return { ..._item, quantity: Number(e.target.value) };
                      }
                      return _item;
                    })
                  }))
                }}
                className="!h-8 !w-10 !rounded-none !border-0 !bg-transparent !px-0 text-center !text-[13px] font-semibold"
              />
              <button
                type="button"
                aria-label={t('common:actions.add')}
                onClick={() => {
                  setState(prev => ({
                    ...prev,
                    cart: prev.cart.map((_item) => {
                      if( item.id === _item.id ) {
                        return { ..._item, quantity: _item.quantity + 1 };
                      }
                      return _item;
                    })
                  }))
                }}
              >
                <FontAwesomeIcon icon={faPlus} className="text-[10px]" />
              </button>
            </div>
          ) : (
            <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-md bg-surface text-[13px] font-semibold text-foreground tnum">
              {item.quantity}
            </span>
          )}

          <div className="min-w-0 flex-1">
            <div className={cn(
              "min-w-0 text-[13.5px] font-medium leading-snug",
              item.deleted_at ? 'line-through text-danger' : ''
            )}>
              <CartItemName item={item} mainItem={item} />
            </div>

            {item.newOrOld === MenuItemType.new && (
              <div className="mt-1.5 flex items-center gap-1">
                {item?.selectedGroups?.length > 0 && (
                  <button
                    type="button"
                    aria-label={t('common:actions.edit')}
                    title={t('common:actions.edit')}
                    className="inline-flex h-6 items-center gap-1 rounded px-1 text-[11px] text-muted transition-colors hover:bg-foreground/5 hover:text-foreground"
                    onClick={(event) => {
                      event.stopPropagation();
                      setModifiersOpen(true);
                    }}
                  >
                    <FontAwesomeIcon icon={faPencil} className="text-[9px]" />
                    {t('common:actions.edit')}
                  </button>
                )}
                <button
                  type="button"
                  aria-label={t('seats.addComment')}
                  title={t('seats.addComment')}
                  className="inline-flex h-6 items-center gap-1 rounded px-1 text-[11px] text-muted transition-colors hover:bg-foreground/5 hover:text-foreground"
                  onClick={(event) => {
                    event.stopPropagation();
                    setCommentText(item.comments || "");
                    setCommentKeyboardOpen(true);
                  }}
                >
                  <FontAwesomeIcon icon={faComment} className="text-[9px]" />
                  {t('seats.addComment')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {isModifiersOpen && (
        <MenuDishModifiers
          isOpen={isModifiersOpen}
          dish={item.dish}
          groups={item.selectedGroups}
          level={item.level + 1}
          editing={true}
          onClose={(groups) => {
            setModifiersOpen(false);
            // update item — match by stable id, never by list index: the index
            // prop is positional within a seat-filtered list and shifts on
            // removal/reorder, so index writes landed on the wrong line.
            setState(prev => ({
              ...prev,
              cart: prev.cart.map((cItem) => {
                if(cItem.id === item.id){
                  return { ...cItem, selectedGroups: groups };
                }
                return cItem;
              })
            }))
          }}
        />
      )}
      {isCommentKeyboardOpen && (
        <VirtualKeyboard
          open={isCommentKeyboardOpen}
          onClose={() => {
            setCommentKeyboardOpen(false);
            setState(prev => ({
              ...prev,
              cart: prev.cart.map((_item) => {
                if (item.id === _item.id) {
                  _item.comments = commentText;
                }
                return _item;
              })
            }));
          }}
          type="text"
          placeholder={t('seats.addComment')}
          value={commentText}
          onChange={(v) => setCommentText(v)}
        />
      )}
    </>
  );
}