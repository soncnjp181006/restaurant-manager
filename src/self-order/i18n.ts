/**
 * Tiny dictionary for the customer-facing self-order page (/order.html).
 *
 * This page is opened by guests scanning a table QR code, so it must follow the
 * language of the venue rather than requiring a login. Resolution order:
 *   1. `?lang=vi|en` in the URL
 *   2. the language saved by this device in the POS (`app-state`, page.language)
 *   3. the browser language (vi → Vietnamese)
 *   4. English
 * The page is a separate entry point (its own module graph), which is why it does
 * not use the app's i18next namespaces — those are keyed to the POS screens.
 */
export type SelfOrderLang = 'en' | 'vi';

const EN = {
  pageTitle: 'Order from your table',
  missingTableCode: 'This link is missing its table code. Please scan the QR code on your table again.',
  confirmingPayment: 'Confirming your payment',
  sorry: 'We’re sorry',
  tryAgain: 'Try again',
  preparingMenu: 'Preparing the menu',
  dismiss: 'Dismiss',
  addedToOrder: '{name} added to your order',
  viewYourOrder: 'View your order',
  welcome: 'Welcome',
  table: 'Table {label}',
  ourMenu: 'Our Menu',
  welcomeText: 'Choose at your leisure, pay from your seat — we’ll bring everything to your table.',
  searchDishes: 'Search dishes',
  nothingMatches: 'Nothing matches “{query}”.',
  dishesCount: '{count} dishes',
  from: 'from',
  add: 'Add',
  qtyInOrder: '{qty} in your order',
  thankYouDining: 'Thank you for dining with us',
  close: 'Close',
  less: 'Less',
  more: 'More',
  makeItYours: 'Make it yours',
  pickYourOptions: 'Pick your options',
  addToOrder: 'Add to order',
  optional: 'Optional',
  selected: '✓ Selected',
  required: 'Required',
  chooseCount: 'Choose {count}',
  specialRequests: 'Special requests',
  specialRequestsPlaceholder: 'Allergies, no onions, well done…',
  yourOrder: 'Your order',
  itemsCount: '{count} items',
  continueToPayment: 'Continue to payment',
  emptyOrder: 'Your order is empty.',
  taxAddedAtPayment: '{name} ({rate}%) is added at payment.',
  payment: 'Payment',
  reviewAndPay: 'Review & pay',
  oneMoment: 'One moment…',
  placeOrderTest: 'Place order · test',
  total: 'Total',
  calculatingTotal: 'Calculating your total…',
  included: '(included)',
  yourNameOptional: 'Your name · optional',
  yourNamePlaceholder: 'So we know who ordered',
  kitchenNoteOptional: 'Note for the kitchen · optional',
  kitchenNotePlaceholder: 'Allergies, timing…',
  payWith: 'Pay with',
  onlineUnavailable: 'Online payment isn’t available right now. Please order with our staff.',
  demo: 'Demo',
  cardWallet: 'Card · Wallet',
  backToMenu: 'Back to the menu',
  backToMyOrder: 'Back to my order',
  paymentStartFailed: 'We couldn’t start this payment. Please choose another method, or ask a staff member to take your order.',
  loadingSecurePayment: 'Loading secure payment…',
  sendingToKitchen: 'Sending your order to the kitchen…',
  chooseAnotherMethod: 'Choose another payment method',
  securePaymentNote: 'Secure payment — card details never touch our system',
  paymentNotCompleted: 'Payment not completed',
  paymentFailedBody:
    'Your payment didn’t go through, so no order was sent to the kitchen. Your order is still here — you can try again.',
  tryPaymentAgain: 'Try payment again',
  orderConfirmed: 'Order confirmed',
  orderReadyTitle: 'Your order is ready!',
  thankYou: 'Thank you',
  orderReadyBody: 'The kitchen has finished your order — we’ll bring it to your table.',
  orderWaitingBody: 'Your order is paid and with the kitchen. Keep this page open — we’ll alert you here when it’s ready.',
  orderReadyChip: 'Your order is ready',
  orderReadyHint: 'Please collect it from the counter or wait for it at your table.',
  orderNumber: 'Order number',
  paid: 'Paid',
  orderSomethingElse: 'Order something else',
  cardNotSetup: 'Card payment is not set up correctly. Please ask a staff member.',
  paypalNotSetup: 'PayPal is not set up correctly. Please ask a staff member.',
};

export type SelfOrderKey = keyof typeof EN;

const VI: Record<SelfOrderKey, string> = {
  pageTitle: 'Gọi món tại bàn',
  missingTableCode: 'Liên kết này thiếu mã bàn. Vui lòng quét lại mã QR trên bàn của bạn.',
  confirmingPayment: 'Đang xác nhận thanh toán',
  sorry: 'Xin lỗi quý khách',
  tryAgain: 'Thử lại',
  preparingMenu: 'Đang chuẩn bị thực đơn',
  dismiss: 'Đóng',
  addedToOrder: 'Đã thêm {name} vào đơn của bạn',
  viewYourOrder: 'Xem đơn của bạn',
  welcome: 'Chào mừng',
  table: 'Bàn {label}',
  ourMenu: 'Thực đơn',
  welcomeText: 'Thong thả chọn món, thanh toán tại chỗ — chúng tôi mang món ra tận bàn.',
  searchDishes: 'Tìm món',
  nothingMatches: 'Không tìm thấy món nào khớp “{query}”.',
  dishesCount: '{count} món',
  from: 'từ',
  add: 'Thêm',
  qtyInOrder: '{qty} trong đơn của bạn',
  thankYouDining: 'Cảm ơn quý khách đã dùng bữa',
  close: 'Đóng',
  less: 'Giảm',
  more: 'Tăng',
  makeItYours: 'Tuỳ chỉnh món',
  pickYourOptions: 'Chọn tuỳ chọn',
  addToOrder: 'Thêm vào đơn',
  optional: 'Không bắt buộc',
  selected: '✓ Đã chọn',
  required: 'Bắt buộc',
  chooseCount: 'Chọn {count}',
  specialRequests: 'Yêu cầu đặc biệt',
  specialRequestsPlaceholder: 'Dị ứng, không hành, chín kỹ…',
  yourOrder: 'Đơn của bạn',
  itemsCount: '{count} món',
  continueToPayment: 'Tiếp tục thanh toán',
  emptyOrder: 'Đơn của bạn đang trống.',
  taxAddedAtPayment: '{name} ({rate}%) được cộng khi thanh toán.',
  payment: 'Thanh toán',
  reviewAndPay: 'Kiểm tra & thanh toán',
  oneMoment: 'Vui lòng đợi…',
  placeOrderTest: 'Đặt món · thử nghiệm',
  total: 'Tổng cộng',
  calculatingTotal: 'Đang tính tổng tiền…',
  included: '(đã bao gồm)',
  yourNameOptional: 'Tên của bạn · không bắt buộc',
  yourNamePlaceholder: 'Để chúng tôi biết ai đã gọi món',
  kitchenNoteOptional: 'Ghi chú cho bếp · không bắt buộc',
  kitchenNotePlaceholder: 'Dị ứng, thời gian…',
  payWith: 'Thanh toán bằng',
  onlineUnavailable: 'Hiện chưa thể thanh toán trực tuyến. Vui lòng gọi món với nhân viên.',
  demo: 'Thử nghiệm',
  cardWallet: 'Thẻ · Ví',
  backToMenu: 'Quay lại thực đơn',
  backToMyOrder: 'Quay lại đơn của tôi',
  paymentStartFailed: 'Không thể bắt đầu thanh toán. Vui lòng chọn cách khác hoặc nhờ nhân viên ghi đơn.',
  loadingSecurePayment: 'Đang tải thanh toán bảo mật…',
  sendingToKitchen: 'Đang gửi đơn tới bếp…',
  chooseAnotherMethod: 'Chọn cách thanh toán khác',
  securePaymentNote: 'Thanh toán bảo mật — thông tin thẻ không đi qua hệ thống của chúng tôi',
  paymentNotCompleted: 'Chưa hoàn tất thanh toán',
  paymentFailedBody:
    'Thanh toán chưa thành công nên đơn chưa được gửi tới bếp. Đơn của bạn vẫn còn — bạn có thể thử lại.',
  tryPaymentAgain: 'Thử thanh toán lại',
  orderConfirmed: 'Đã xác nhận đơn',
  orderReadyTitle: 'Đơn của bạn đã sẵn sàng!',
  thankYou: 'Cảm ơn quý khách',
  orderReadyBody: 'Bếp đã làm xong đơn — chúng tôi sẽ mang ra bàn cho bạn.',
  orderWaitingBody: 'Đơn đã thanh toán và đang ở bếp. Giữ trang này mở — chúng tôi sẽ báo khi món sẵn sàng.',
  orderReadyChip: 'Đơn của bạn đã sẵn sàng',
  orderReadyHint: 'Vui lòng nhận tại quầy hoặc chờ tại bàn.',
  orderNumber: 'Số đơn',
  paid: 'Đã thanh toán',
  orderSomethingElse: 'Gọi món khác',
  cardNotSetup: 'Thanh toán thẻ chưa được thiết lập đúng. Vui lòng nhờ nhân viên.',
  paypalNotSetup: 'PayPal chưa được thiết lập đúng. Vui lòng nhờ nhân viên.',
};

const DICTS: Record<SelfOrderLang, Record<SelfOrderKey, string>> = { en: EN, vi: VI };

/** Exposed for tests: single pass `{name}` interpolation, unknown names kept. */
export const interpolate = (template: string, vars?: Record<string, string | number>): string => {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
};

/** Exposed for tests: the two dictionaries must stay key-for-key identical. */
export const selfOrderDictionaries = (): Record<SelfOrderLang, Record<SelfOrderKey, string>> => DICTS;

const isLang = (value: unknown): value is SelfOrderLang => value === 'en' || value === 'vi';

/** Read the POS device language saved by the app (atomWithStorage `app-state`). */
function storedLanguage(): SelfOrderLang | null {
  try {
    const raw = window.localStorage.getItem('app-state');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { page?: { language?: string } } | null;
    return isLang(parsed?.page?.language) ? parsed.page!.language! : null;
  } catch {
    return null;
  }
}

/** Pure resolution order — exposed so the precedence itself is testable. */
export function pickSelfOrderLang(input: {
  query?: string | null;
  stored?: string | null;
  browser?: string | null;
}): SelfOrderLang {
  if (isLang(input.query)) return input.query;
  if (isLang(input.stored)) return input.stored;
  return (input.browser ?? '').toLowerCase().startsWith('vi') ? 'vi' : 'en';
}

export function resolveSelfOrderLang(search: string = window.location.search): SelfOrderLang {
  return pickSelfOrderLang({
    query: new URLSearchParams(search).get('lang'),
    stored: storedLanguage(),
    browser: typeof navigator === 'undefined' ? '' : navigator.language,
  });
}

let current: SelfOrderLang | null = null;

export function selfOrderLang(): SelfOrderLang {
  if (!current) current = resolveSelfOrderLang();
  return current;
}

/** Translate one key, interpolating `{name}` placeholders. */
export function tr(key: SelfOrderKey, vars?: Record<string, string | number>): string {
  const dict = DICTS[selfOrderLang()];
  return interpolate(dict[key] ?? EN[key], vars);
}
