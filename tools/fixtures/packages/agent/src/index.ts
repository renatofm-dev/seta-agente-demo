// fixture VIOLADORA: agent importando o ERP direto — por SQL (erp-connector) e
// por HTTP (erp-api-tse). Nos dois casos passaria por cima do catálogo.

import { escritor } from '../../erp-api-tse/src/index';
import { impl } from '../../erp-connector/src/index';

export const uso = impl;
export const escreve = escritor;
