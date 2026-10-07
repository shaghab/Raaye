import { TestBed } from '@angular/core/testing';
import { ChipComponent } from './ui';

describe('ChipComponent', () => {
  it('renders the label for a code with the matching tone', async () => {
    await TestBed.configureTestingModule({ imports: [ChipComponent] }).compileComponents();
    const fixture = TestBed.createComponent(ChipComponent);
    fixture.componentRef.setInput('code', 'DELIVERED');
    await fixture.whenStable();
    const span = fixture.nativeElement.querySelector('span') as HTMLSpanElement;
    expect(span.textContent?.trim()).toBe('Delivered');
    expect(span.className).toContain('ok');
    fixture.componentRef.setInput('code', 'FAILED');
    await fixture.whenStable();
    expect(span.className).toContain('bad');
  });
});
