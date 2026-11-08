import { cn } from "@/lib/utils.ts";
import { useAtom } from "jotai";
import { appSettings, appState } from "@/store/jotai.ts";
import ScrollContainer from 'react-indiana-drag-scroll'
import {CSSProperties, useEffect, useMemo} from "react";
import {resolveMenuAwareData} from "@/lib/menu.resolver.ts";


export const MenuCategories = () => {
  const [settings] = useAtom(appSettings);
  const [state, setState] = useAtom(appState);

  const {categories} = useMemo(() => (
    resolveMenuAwareData({
      categories: settings.categories,
      dishes: settings.dishes,
      menus: settings.menus
    })
  ), [settings.categories, settings.dishes, settings.menus]);

  useEffect(() => {
    const currentCategoryExists = categories.some(
      category => category.id?.toString() === state.category?.id?.toString()
    );

    if (categories.length > 0 && (!state.category || !currentCategoryExists)) {
      setState(prev => ({
        ...prev,
        category: categories[0]
      }));
      return;
    }

    if (categories.length === 0 && state.category) {
      setState(prev => ({
        ...prev,
        category: undefined
      }));
    }
  }, [categories, state.category]);

  return (
    <div data-testid="menu-categories">
      <ScrollContainer className="flex flex-row gap-1" mouseScroll>
        {categories.map((item, index) => (
          <button
            key={index}
            type="button"
            data-testid={`menu-category-${index}`}
            data-active={state?.category?.id?.toString() === item?.id?.toString()}
            className="category-chip"
            onClick={() => setState(prev => ({
              ...prev,
              category: item
            }))}
          >
            {item.name}
          </button>
        ))}
      </ScrollContainer>
    </div>
  )
}
