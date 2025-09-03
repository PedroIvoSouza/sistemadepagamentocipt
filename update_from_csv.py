import sqlite3
import json
import sys

def force_update_responsibles_from_json(db_path, json_path):
    """
    Atualiza o campo 'nome_responsavel' na tabela Clientes_Eventos
    usando dados de um arquivo JSON. 
    Esta versão SOBRESCREVE o nome do responsável existente no banco de dados
    com o nome do arquivo JSON, caso um documento correspondente seja encontrado.

    Args:
        db_path (str): Caminho para o banco de dados SQLite.
        json_path (str): Caminho para o arquivo JSON de entrada.
    """
    try:
        with open(json_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except FileNotFoundError:
        print(f"ERRO: O arquivo JSON '{json_path}' não foi encontrado.")
        sys.exit(1)
    except json.JSONDecodeError:
        print(f"ERRO: O arquivo '{json_path}' não é um JSON válido.")
        sys.exit(1)

    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()

        updated_clients = []
        not_found_in_db = []
        
        print("Iniciando a atualização (modo de sobrescrita)...")

        # Itera sobre cada entrada no arquivo JSON
        for entry in data:
            client_data = entry.get('cliente', {})
            doc_norm_json = client_data.get('documento')
            responsavel_json = client_data.get('nome_responsavel')
            razao_social_json = client_data.get('nome_razao_social_oficial', client_data.get('nome_razao_social'))

            # Pula se não houver documento ou responsável no JSON
            if not doc_norm_json or not responsavel_json:
                continue

            # Tenta atualizar o banco de dados, sobrescrevendo o valor existente.
            cursor.execute("""
                UPDATE Clientes_Eventos
                SET nome_responsavel = ?
                WHERE documento_norm = ?
            """, (responsavel_json, doc_norm_json))

            # Se uma linha foi afetada, a atualização ocorreu
            if cursor.rowcount > 0:
                updated_clients.append(f"- {razao_social_json} (Responsável: {responsavel_json})")
            else:
                # Se rowcount for 0, ninguém com aquele documento foi encontrado no DB
                not_found_in_db.append(f"- {razao_social_json} (Documento: {doc_norm_json})")
        
        # Salva (comita) as alterações no banco
        conn.commit()
        print("Processo concluído.")

        # --- Relatório Final ---
        print("\n--- Relatório de Atualização (Modo de Sobrescrita) ---")
        if updated_clients:
            print(f"Foram atualizados/sobrescritos {len(updated_clients)} clientes com o nome do responsável:")
            for client in updated_clients[:15]: # Mostra os 15 primeiros
                print(client)
            if len(updated_clients) > 15:
                print(f"... e mais {len(updated_clients) - 15}.")
        else:
            print("Nenhum cliente do arquivo JSON foi encontrado no banco de dados para ser atualizado.")

        if not_found_in_db:
            print(f"\n{len(not_found_in_db)} clientes do JSON não foram encontrados no banco de dados:")
            for client in not_found_in_db[:15]: # Mostra os 15 primeiros
                print(client)
            if len(not_found_in_db) > 15:
                print(f"... e mais {len(not_found_in_db) - 15}.")


    except sqlite3.Error as e:
        print(f"ERRO de banco de dados: {e}")
        if conn:
            conn.rollback()
    except Exception as e:
        print(f"Ocorreu um erro inesperado: {e}")
    finally:
        if conn:
            conn.close()

# --- INSTRUÇÕES DE USO NA SUA VM ---
# 1. Faça um backup do seu banco de dados por segurança:
#    cp sistemacipt.db sistemacipt.db.bkp_before_overwrite
#
# 2. Suba este arquivo (update_from_json.py) e o arquivo 
#    'dados_prontos_para_importar (1).json' para a mesma pasta
#    onde está o seu banco 'sistemacipt.db'.
#
# 3. Execute o script no terminal com o comando:
#    python3 update_from_json.py

if __name__ == '__main__':
    DATABASE_FILE = 'sistemacipt.db'
    JSON_FILE = 'dados_prontos_para_importar (1).json'
    
    force_update_responsibles_from_json(DATABASE_FILE, JSON_FILE)

