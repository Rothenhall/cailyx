import type { Config } from 'tailwindcss';

/**
 * Tailwind configuration for the Cailyx web app.
 *
 * Every color here resolves to a CSS custom property defined in
 * `src/app/globals.css`, which is the single source of truth for
 * design_plan.md §3.1's token table. Components must never write a raw hex
 * value — that is what makes a future theme/branding override (G20) possible
 * without touching component source.
 */
const config: Config = {
    darkMode: ['class'],
    content: ['./src/**/*.{ts,tsx}'],
  theme: {
  	extend: {
  		colors: {
  			canvas: 'hsl(var(--canvas))',
  			surface: {
  				DEFAULT: 'hsl(var(--surface))',
  				raised: 'hsl(var(--surface-raised))',
  				sunken: 'hsl(var(--surface-sunken))'
  			},
  			border: 'hsl(var(--border))',
  			'border-strong': 'hsl(var(--border-strong))',
  			input: 'hsl(var(--border-strong))',
  			ring: 'hsl(var(--ring))',
  			foreground: 'hsl(var(--foreground))',
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			primary: {
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))',
  				hover: 'hsl(var(--primary-hover))',
  				subtle: 'hsl(var(--primary-subtle))'
  			},
  			success: {
  				DEFAULT: 'hsl(var(--success))',
  				foreground: 'hsl(var(--success-foreground))',
  				subtle: 'hsl(var(--success-subtle))'
  			},
  			warning: {
  				DEFAULT: 'hsl(var(--warning))',
  				foreground: 'hsl(var(--warning-foreground))',
  				subtle: 'hsl(var(--warning-subtle))'
  			},
  			danger: {
  				DEFAULT: 'hsl(var(--danger))',
  				foreground: 'hsl(var(--danger-foreground))',
  				subtle: 'hsl(var(--danger-subtle))'
  			},
  			info: {
  				DEFAULT: 'hsl(var(--info))',
  				foreground: 'hsl(var(--info-foreground))',
  				subtle: 'hsl(var(--info-subtle))'
  			},
  			unmeasured: {
  				DEFAULT: 'hsl(var(--unmeasured))',
  				foreground: 'hsl(var(--unmeasured-foreground))',
  				subtle: 'hsl(var(--unmeasured-subtle))'
  			},
  			background: 'hsl(var(--canvas))',
  			card: {
  				DEFAULT: 'hsl(var(--surface))',
  				foreground: 'hsl(var(--foreground))'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--surface))',
  				foreground: 'hsl(var(--foreground))'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--surface-sunken))',
  				foreground: 'hsl(var(--foreground))'
  			},
  			accent: {
  				DEFAULT: 'hsl(var(--surface-sunken))',
  				foreground: 'hsl(var(--foreground))'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--danger))',
  				foreground: 'hsl(var(--danger-foreground))'
  			}
  		},
  		borderRadius: {
  			sm: 'calc(var(--radius-input) - 2px)',
  			md: 'var(--radius-input)',
  			lg: 'var(--radius-card)',
  			xl: 'var(--radius-dialog)'
  		},
  		fontFamily: {
  			sans: [
  				'var(--font-sans)'
  			],
  			mono: [
  				'var(--font-mono)'
  			]
  		},
  		fontSize: {
  			meta: [
  				'0.75rem',
  				{
  					lineHeight: '1rem'
  				}
  			],
  			table: [
  				'0.875rem',
  				{
  					lineHeight: '1.25rem'
  				}
  			],
  			body: [
  				'1rem',
  				{
  					lineHeight: '1.5rem'
  				}
  			],
  			subsection: [
  				'1.25rem',
  				{
  					lineHeight: '1.75rem'
  				}
  			],
  			title: [
  				'1.75rem',
  				{
  					lineHeight: '2.25rem',
  					letterSpacing: '-0.01em'
  				}
  			],
  			kpi: [
  				'2.25rem',
  				{
  					lineHeight: '2.5rem',
  					letterSpacing: '-0.02em'
  				}
  			]
  		},
  		spacing: {
  			nav: '240px',
  			topbar: '64px'
  		},
  		maxWidth: {
  			content: '1440px',
  			reading: '920px'
  		},
  		boxShadow: {
  			overlay: '0 8px 24px -4px hsl(var(--shadow) / 0.12), 0 2px 6px -2px hsl(var(--shadow) / 0.08)',
  			none: 'none'
  		},
  		keyframes: {
  			'accordion-down': {
  				from: {
  					height: '0'
  				},
  				to: {
  					height: 'var(--radix-accordion-content-height)'
  				}
  			},
  			'accordion-up': {
  				from: {
  					height: 'var(--radix-accordion-content-height)'
  				},
  				to: {
  					height: '0'
  				}
  			}
  		},
  		animation: {
  			'accordion-down': 'accordion-down 0.2s ease-out',
  			'accordion-up': 'accordion-up 0.2s ease-out'
  		}
  	}
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
