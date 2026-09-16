// fixture VIOLADORA: o cliente do TSE é FOLHA — importar o agente inverte a
// dependência e deixa o adapter conhecer o grafo do turno (proibido — spec 036)
import { uso } from '../../agent/src/index';

export const escritor = uso;
