import './tailwind.css';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider, createTheme } from '@mantine/core';
import { DialogHost } from './dialogs';

const theme = createTheme({
  fontFamily: 'system-ui, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif',
  // 기본(12·14·16·18·20)보다 한 치수씩 키운다
  fontSizes: { xs: '0.875rem', sm: '1rem', md: '1.125rem', lg: '1.25rem', xl: '1.375rem' },
});

/** 모든 화면의 시작점: Mantine 기본 테마(라이트/다크는 기기 설정을 따름) */
export function mountApp(node: ReactNode) {
  createRoot(document.getElementById('root')!).render(
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <div className="min-h-screen bg-[light-dark(var(--mantine-color-gray-0),var(--mantine-color-dark-8))]">{node}</div>
      <DialogHost />
    </MantineProvider>,
  );
}
