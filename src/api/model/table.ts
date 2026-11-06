import { ID, Name, Priority } from "@/api/model/common.ts";
import { Category } from "@/api/model/category.ts";
import { PaymentType } from "@/api/model/payment_type.ts";
import { OrderType } from "@/api/model/order_type.ts";
import { Floor } from "@/api/model/floor.ts";
import { DateTime } from "surrealdb";

export interface Table extends ID, Name, Priority {
  number: string
  capacity?: number
  ask_for_covers?: boolean
  allow_multiple_orders?: boolean

  background?: string
  color?: string

  height?: number
  width?: number
  x?: number
  y?: number
  rounded?: string

  floor?: Floor

  categories?: Category[]
  order_types?: OrderType[]
  payment_types?: PaymentType[]

  is_block?: boolean
  block_source?: string

  is_locked?: boolean
  locked_at?: DateTime
  locked_by?: string

  deleted_at?: DateTime
}

export const TABLE_FETCHES = ['floor', 'categories', 'payment_types', 'order_types'];

/**
 * Table tiles used to render `${name}${number}`, so "Bàn 1" + number "1" read
 * as "Bàn 11". Join with a space, and skip the number when the name already
 * ends with it — every surface that names a table goes through this.
 */
export const getTableLabel = (
  table?: { name?: string | null; number?: string | number | null } | null,
): string => {
  const name = table?.name == null ? '' : String(table.name).trim();
  const number = table?.number == null ? '' : String(table.number).trim();
  if (!name) return number;
  if (!number || name.endsWith(number)) return name;
  return `${name} ${number}`;
};