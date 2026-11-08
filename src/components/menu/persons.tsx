import { useAtom } from "jotai";
import { appAlert, appState, closingEnforcementAtom } from "@/store/jotai.ts";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils.ts";
import { posStore } from "@/infrastructure/pos-store/pos-store.ts";
import {getClosingEnforcementStateLocal} from "@/lib/closing.guard.ts";
import {useTranslation} from "react-i18next";
import i18n from "@/lib/i18n.ts";

export const MenuPersons = () => {
  const { t } = useTranslation('menu');
  const [state, setState] = useAtom(appState);
  const [enforcement] = useAtom(closingEnforcementAtom);
  const [, setAlert] = useAtom(appAlert);
  const [error, setError] = useState(false);
  const [first, setFirst] = useState(true);

  useEffect(() => {
    if (!enforcement.orderTakingBlocked || state.showFloor) {
      return;
    }

    setState(prev => ({
      ...prev,
      showFloor: true,
      showPersons: false,
      table: undefined,
      order: undefined,
      orders: [],
      cart: [],
    }));

    if (enforcement.message) {
      setAlert(prev => ({
        ...prev,
        message: enforcement.message!,
        type: "warning",
        opened: true,
      }));
    }
  }, [enforcement.message, enforcement.orderTakingBlocked, setAlert, setState, state.showFloor]);

  const onKey = (key: string) => {
    setState(prev => ({
      ...prev,
      persons: first ? key : parseInt(prev.persons ? prev.persons + key : key).toString()
    }));

    setFirst(false);
  }

  const onOk = async () => {
    if( !state.persons || state.persons.trim() === '' || state.persons.trim() === '0' ) {
      setError(true);
      return;
    }

    // PosStore settings only — do not hit Surreal on covers confirm.
    const enforcementState = await getClosingEnforcementStateLocal(
      new Date(),
      enforcement.dayClosingCompleted,
    );
    if (enforcementState.orderTakingBlocked) {
      setAlert(prev => ({
        ...prev,
        message: enforcementState.message ?? i18n.t('closing:orderTakingDisabled'),
        type: "warning",
        opened: true,
      }));
      setState(prev => ({
        ...prev,
        showFloor: true,
        showPersons: false,
        table: undefined,
        order: undefined,
        orders: [],
        cart: [],
      }));
      return;
    }

    setState(prev => ({
      ...prev,
      showPersons: false,
    }));

    // if we have order set in the order directly — Dexie first, outbox syncs.
    if(state.order.id !== 'new'){
      try {
        await posStore.mergeOrder(
          String(state.order.id),
          { covers: parseInt(state?.persons) },
          { seed: { order: state.order.order ?? { id: state.order.id }, items: state.order.order?.items } },
        );
      } catch (error) {
        console.error('Failed to update covers', error);
      }
    }
  }

  useEffect(() => {
    if( error ) {
      setTimeout(() => setError(false), 400);
    }
  }, [error]);

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-8 bg-canvas px-4" data-testid="menu-persons-screen">
      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className={cn("text-[24px] font-semibold tracking-[-0.02em]", error && 'login-error')}>
          {t('persons.chooseCount')}
        </h2>
        <p className="text-[13px] text-muted">
          {t('persons.hint', { defaultValue: 'How many guests are at this table?' })}
        </p>
        <div className="mt-3 min-w-[120px] rounded-[10px] border border-border bg-surface px-6 py-2 text-center text-[32px] font-semibold leading-none tnum">
          {state.persons || '0'}
        </div>
      </div>

      <div className="w-full max-w-[340px]">
        <div className="keypad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
            <button key={digit} type="button" onClick={() => onKey(digit)} className="keypad-key">
              {digit}
            </button>
          ))}
          <button
            type="button"
            aria-label={t('persons.clear', { defaultValue: 'Clear' })}
            onClick={() => setState(prev => ({
              ...prev,
              persons: undefined
            }))}
            className="keypad-key keypad-key--danger"
          >
            C
          </button>
          <button type="button" onClick={() => onKey('0')} className="keypad-key">0</button>
          <button
            type="button"
            onClick={onOk}
            data-testid="menu-persons-ok"
            className="keypad-key keypad-key--confirm"
          >
            {t('persons.confirm', { defaultValue: 'OK' })}
          </button>
        </div>
      </div>
    </div>
  );
}
