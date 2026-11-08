import { faPlus } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { nanoid } from "nanoid";
import ScrollContainer from "react-indiana-drag-scroll";
import React, { useMemo } from "react";
import { useAtom } from "jotai";
import { appState } from "@/store/jotai.ts";
import { useTranslation } from "react-i18next";

export const Seats = () => {
  const [state, setState] = useAtom(appState);
  const { t } = useTranslation('cart');

  const noSeat = useMemo(() => {
    return state.cart.some(item => item.seat === undefined);
  }, [state.cart]);

  return (
    <ScrollContainer className="clean-scroll">
      <div className="flex items-center gap-1.5" data-testid="cart-seats">
        <button
          type="button"
          className="chip !h-8 !px-2.5 !text-[12.5px]"
          data-testid="cart-add-seat"
          onClick={() => {
            const newSeat = nanoid();
            setState(prev => ({
              ...prev,
              seats: [
                ...prev.seats,
                newSeat
              ],
              seat: newSeat
            }))
          }}
        >
          <FontAwesomeIcon icon={faPlus} className="text-[9px]" />
          {t('seats.seat')}
        </button>
        {noSeat && (
          <button
            type="button"
            className="chip !h-8 whitespace-nowrap !text-[12.5px]"
            data-active={undefined === state.seat}
            onClick={() => setState(prev => ({
              ...prev,
              seat: undefined
            }))}
          >{t('seats.noSeat')}</button>
        )}
        {state.seats.map((item, index) => (
          <button
            type="button"
            className="chip !h-8 whitespace-nowrap !text-[12.5px] tnum"
            aria-label={t('seats.seatNumber', { number: index + 1 })}
            data-active={item === state.seat}
            onClick={() => setState(prev => ({
              ...prev,
              seat: item
            }))}
            key={index}
          >{index + 1}</button>
        ))}
      </div>
    </ScrollContainer>
  )
}
