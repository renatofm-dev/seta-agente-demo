import { createSimulatedPaymentProvider } from '@seta/payment-provider';
import { describe, expect, it } from 'vitest';

describe('spec 014 — PSP simulado', () => {
  it('cria cobrança com ids determinísticos, links e códigos fictícios', async () => {
    const psp = createSimulatedPaymentProvider();
    expect(psp.ambiente).toBe('simulado');
    const cliente = await psp.garantirCliente({
      documento: '12345678909',
      nome: 'Titular',
      referenciaExterna: 'contrato:10002',
    });
    expect(cliente).toEqual({ id: 'sim_cus_1' });
    // idempotente por referência
    await expect(
      psp.garantirCliente({
        documento: '12345678909',
        nome: 'T',
        referenciaExterna: 'contrato:10002',
      }),
    ).resolves.toEqual({ id: 'sim_cus_1' });

    const c = await psp.criarCobranca({
      clienteId: 'sim_cus_1',
      valorCentavos: 85050,
      vencimento: '2026-09-05',
      descricao: 'd',
      referenciaExterna: 'contrato:10002:titulos:7',
      metodo: 'boleto',
    });
    expect(c.id).toBe('sim_pay_1');
    expect(c.status).toBe('pendente');
    expect(c.urlBoleto).toContain('sim_pay_1');
    expect(c.urlFatura).toContain('sim_pay_1');

    const linha = await psp.obterLinhaDigitavel(c.id);
    expect(linha.linhaDigitavel).toHaveLength(47);
    const pix = await psp.obterPix(c.id);
    expect(pix.payload).toMatch(/^00020126/);
    expect(pix.payload).toContain('850.50');
  });

  it('buscarPorReferencia acha a aberta; simularRecebimento e cancelar mudam o status', async () => {
    const psp = createSimulatedPaymentProvider();
    const c = await psp.criarCobranca({
      clienteId: 'sim_cus_1',
      valorCentavos: 100,
      vencimento: '2026-09-05',
      descricao: 'd',
      referenciaExterna: 'ref',
      metodo: 'pix',
    });
    await expect(psp.buscarPorReferencia('ref')).resolves.toMatchObject({ id: c.id });
    await expect(psp.buscarPorReferencia('outra')).resolves.toBeNull();

    await psp.simularRecebimento(c.id, 100);
    expect(psp.cobrancas.get(c.id)?.status).toBe('recebida');
    await psp.cancelarCobranca(c.id);
    expect(psp.cobrancas.get(c.id)?.status).toBe('cancelada');
    expect(psp.chamadas.criarCobranca).toBe(1);
  });
});
