import '@mantine/core/styles.css';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Box, MantineProvider, createTheme } from '@mantine/core';
import { DialogHost } from './dialogs';

const theme = createTheme({
  fontFamily: 'system-ui, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif',
});

/** 모든 화면의 시작점: Mantine 기본 테마(라이트/다크는 기기 설정을 따름) */
export function mountApp(node: ReactNode) {
  createRoot(document.getElementById('root')!).render(
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <Box mih="100vh" bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-8))">{node}</Box>
      <DialogHost />
    </MantineProvider>,
  );
}
