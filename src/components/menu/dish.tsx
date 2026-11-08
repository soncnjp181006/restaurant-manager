import {withCurrency} from "@/lib/utils.ts";
import {Dish} from "@/api/model/dish.ts";
import {useCallback, useEffect, useMemo, useState} from "react";
import {useAtom} from "jotai";
import {appSettings, appState, appPage} from "@/store/jotai.ts";
import {MenuDishModifiers} from "@/components/menu/modifiers.tsx";
import {CartModifierGroup, MenuItem, MenuItemType} from "@/api/model/cart_item.ts";
import {nanoid} from "nanoid";
import {detectMimeType} from "@/utils/files.ts";
import defaultImage from '@/assets/images/default-dish.svg';
import {useDB} from "@/api/db/db.ts";
import {
  buildCartModifierGroups,
  buildNestedGroupsForModifier,
  cloneCartModifierGroups,
} from "@/lib/modifier-groups.ts";
import {Modifier} from "@/api/model/modifier.ts";
import {DishModifierGroup} from "@/api/model/dish_modifier_group.ts";
import {MenuModifierOverrides} from "@/api/model/menu.ts";
import {get} from 'idb-keyval'
import {Tables} from "@/api/db/tables.ts";

const dishImageCache = new Map<string, string>();

interface Props {
  onClick: (item: MenuItem, groups?: CartModifierGroup[], price?: number) => void
  item: Dish
  level: number
  isModifier?: boolean
  price: number
  allowedNextGroupIds?: string[]
  parentModifier?: Modifier
  /** Root dish menu overrides (needed when item is a nested modifier dish) */
  menuModifierOverrides?: MenuModifierOverrides | null
}

export const MenuDish = ({
  onClick,
  item,
  level,
  isModifier,
  price,
  allowedNextGroupIds,
  parentModifier,
  menuModifierOverrides,
}: Props) => {
  const [state] = useAtom(appState);
  const [{groups_dishes}] = useAtom(appSettings);
  const [page] = useAtom(appPage);
  const db = useDB();
  const showDishNumber = page.menuConfig?.showDishNumber !== false;

  const [modifiersModal, setModifiersModal] = useState(false);
  const [imageSrc, setImageSrc] = useState(defaultImage);

  const resolvedMenuOverrides = menuModifierOverrides ?? item.menu_modifier_overrides ?? null;

  const categoryForGroup = useCallback((grp: DishModifierGroup) => {
    return state.category
      ? state.category.name
      : (grp.in?.categories?.length === 1 ? grp.in.categories[0].name : '');
  }, [state.category]);

  const modifierGroups = useMemo(() => {
    const allGroups = groups_dishes.filter((a) => a.in.id.toString() === item.id.toString());

    if (allowedNextGroupIds === undefined) {
      return allGroups;
    }

    return allGroups.filter((g) => allowedNextGroupIds.includes(g.out.id.toString()));
  }, [item.id, groups_dishes, allowedNextGroupIds]);

  const cartModifierGroups = useMemo(() => {
    if (allowedNextGroupIds !== undefined) {
      return buildNestedGroupsForModifier(
        item.id.toString(),
        allowedNextGroupIds,
        groups_dishes,
        level,
        categoryForGroup,
        parentModifier,
        resolvedMenuOverrides
      );
    }

    return buildCartModifierGroups(
      modifierGroups,
      level,
      categoryForGroup,
      parentModifier,
      resolvedMenuOverrides
    );
  }, [
    allowedNextGroupIds,
    item.id,
    groups_dishes,
    level,
    categoryForGroup,
    parentModifier,
    modifierGroups,
    resolvedMenuOverrides,
  ]);

  const hasAutoOpen = useMemo(() => {
    return modifierGroups.filter(m => m.has_required_modifiers || m.should_auto_open).length > 0;
  }, [modifierGroups]);


  const dishCount = useCallback((dish: Dish) => {
    if (isModifier) {
      return null;
    }

    return state.cart.filter(item => item.dish === dish).reduce((prev, item) => prev + item.quantity, 0)
  }, [state.cart]);

  const menuTaxFields = useMemo(() => ({
    tax_mode: item.tax_mode ?? 'exclusive',
    taxes: item.taxes,
  }), [item.tax_mode, item.taxes]);

  useEffect(() => {
    let cancelled = false;
    const dishPhotoId = item?.dish_photo?.toString();

    if (!dishPhotoId) {
      setImageSrc(defaultImage);
      return;
    }

    const cachedImage = dishImageCache.get(dishPhotoId);
    if (cachedImage) {
      setImageSrc(cachedImage);
      return;
    }

    const loadImage = async () => {
      try {
        const images = await get(Tables.documents);

        if(Array.isArray(images)){
          const photo = images.find(image => image.id.toString() === dishPhotoId);

          if (!photo?.content || !(photo.content instanceof ArrayBuffer)) {
            if (!cancelled) {
              setImageSrc(defaultImage);
            }
            return;
          }

          const mimeType = detectMimeType(photo.content, "image/png");
          const blob = new Blob([photo.content], {type: mimeType});
          const objectUrl = URL.createObjectURL(blob);
          dishImageCache.set(dishPhotoId, objectUrl);

          if (!cancelled) {
            setImageSrc(objectUrl);
          }
        }

      } catch {
        if (!cancelled) {
          setImageSrc(defaultImage);
        }
      }
    };

    loadImage();

    return () => {
      cancelled = true;
    };
  }, [item?.dish_photo]);

  return (
    <>
      <div
        className="relative flex select-none p-0.5"
        role="button"
        tabIndex={0}
        data-testid="menu-dish"
        data-dish-name={item.name}
        onClick={() => {
          if (modifierGroups.length > 0 && hasAutoOpen) {
            setModifiersModal(true)
          } else {
            onClick({
              quantity: 1,
              dish: item,
              seat: state.seat,
              id: nanoid(),
              level: level,
              selectedGroups: [],
              newOrOld: MenuItemType.new,
              category: state.category ? state.category?.name : (item.categories?.length === 1 ? item.categories[0].name : ''),
              category_id: state.category?.id?.toString(),
              price: price,
              menu_name: item.menu_name,
              ...menuTaxFields,
            }, undefined, price)
          }
        }}
      >
        <div className="dish-tile flex h-full w-full min-h-[116px] cursor-pointer flex-col justify-between gap-2 p-3.5 text-foreground">
          <div className="flex items-start justify-between gap-2">
            <h6
              className="min-h-0 flex-1 line-clamp-2 text-pretty text-[16px] font-semibold leading-snug tracking-[-0.01em]"
              title={item.name}
            >
              {item.name}
            </h6>
            <img
              loading="lazy"
              src={imageSrc}
              alt=""
              aria-hidden="true"
              className="pointer-events-none h-9 w-9 flex-shrink-0 rounded-lg object-cover"
            />
          </div>
          <div className="flex items-end justify-between gap-2">
            {showDishNumber && item.number != null && String(item.number).trim() !== '' && (
              <span className="text-[11.5px] font-medium text-muted tnum" title={String(item.number)}>
                #{String(item.number).trim()}
              </span>
            )}
            <span className="ml-auto text-[15px] font-semibold tnum" data-price>
              {withCurrency(price)}
            </span>
          </div>
        </div>
        {dishCount(item) ? (
          <span className="dish-qty-badge pr-num">{dishCount(item)}</span>
        ) : null}
      </div>

      {modifierGroups.length > 0 && modifiersModal && (
        <MenuDishModifiers
          dish={{
            ...item,
            menu_modifier_overrides: resolvedMenuOverrides,
          }}
          isOpen={modifiersModal}
          groups={cartModifierGroups}
          onClose={(payload) => {
            if (payload.length > 0) {
              const clonedGroups = cloneCartModifierGroups(payload);
              onClick({
                dish: item,
                seat: state.seat,
                quantity: 1,
                selectedGroups: clonedGroups,
                id: nanoid(),
                isModifier,
                level: level,
                newOrOld: MenuItemType.new,
                category: state.category ? state.category?.name : (item.categories?.length === 1 ? item.categories[0].name : ''),
              category_id: state.category?.id?.toString(),
                price: price,
                menu_name: item.menu_name,
                ...menuTaxFields,
              }, clonedGroups, price);
            }
            setModifiersModal(false);
          }}
          level={level + 1}
        />
      )}
    </>
  )
}
