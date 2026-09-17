// fixture VIOLADORA: reserva (038) é domínio PURO — falar com o ERP daqui tira
// do server a decisão de quando ler, e tira da máquina a propriedade de ser
// testável sem banco (proibido — spec 038)
import { escritor } from '../../erp-api-tse/src/index';

export const reserva = escritor;
