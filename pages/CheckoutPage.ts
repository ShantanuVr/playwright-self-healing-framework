/**
 * @file CheckoutPage.ts
 * @description Sample Page Object Model that exercises the self-healing
 *              wrapper. The POM is the ONLY place aware of selectors – if
 *              the UI mutates, the engine heals them transparently and
 *              this file does not need to change.
 */

import { SmartPage } from '../src/core/SmartPage';

export class CheckoutPage {
  public static readonly ELEMENTS = {
    emailField: 'checkout.emailField',
    couponField: 'checkout.couponField',
    submitButton: 'checkout.submitButton',
    cancelButton: 'checkout.cancelButton',
    statusMessage: 'checkout.statusMessage',
  } as const;

  constructor(private readonly page: SmartPage) {}

  /** Navigates to a relative path within the mock UI server. */
  public async load(relativePath: string): Promise<void> {
    await this.page.raw.goto(relativePath);
  }

  public async fillEmail(value: string): Promise<void> {
    await this.page.fill(
      CheckoutPage.ELEMENTS.emailField,
      value,
      '#email-field',
    );
  }

  public async fillCoupon(value: string): Promise<void> {
    await this.page.fill(
      CheckoutPage.ELEMENTS.couponField,
      value,
      '#coupon-field',
    );
  }

  public async submit(): Promise<void> {
    await this.page.click(
      CheckoutPage.ELEMENTS.submitButton,
      '[data-testid="checkout-submit"]',
    );
  }

  public async cancel(): Promise<void> {
    await this.page.click(
      CheckoutPage.ELEMENTS.cancelButton,
      '#cancel-order',
    );
  }

  public async getStatusMessage(): Promise<string> {
    return this.page.text(
      CheckoutPage.ELEMENTS.statusMessage,
      '#status-message',
    );
  }
}
