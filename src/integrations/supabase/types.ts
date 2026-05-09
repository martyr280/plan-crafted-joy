export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      activity_events: {
        Row: {
          actor_id: string | null
          actor_name: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          message: string
          metadata: Json | null
        }
        Insert: {
          actor_id?: string | null
          actor_name?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          message: string
          metadata?: Json | null
        }
        Update: {
          actor_id?: string | null
          actor_name?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          message?: string
          metadata?: Json | null
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      ar_aging: {
        Row: {
          amount_due: number
          bucket: string
          collection_status: string | null
          customer_email: string | null
          customer_id: string
          customer_name: string
          days_past_due: number
          due_date: string
          id: string
          invoice_number: string
          last_contacted_at: string | null
          synced_at: string
        }
        Insert: {
          amount_due: number
          bucket: string
          collection_status?: string | null
          customer_email?: string | null
          customer_id: string
          customer_name: string
          days_past_due?: number
          due_date: string
          id?: string
          invoice_number: string
          last_contacted_at?: string | null
          synced_at?: string
        }
        Update: {
          amount_due?: number
          bucket?: string
          collection_status?: string | null
          customer_email?: string | null
          customer_id?: string
          customer_name?: string
          days_past_due?: number
          due_date?: string
          id?: string
          invoice_number?: string
          last_contacted_at?: string | null
          synced_at?: string
        }
        Relationships: []
      }
      catalogs: {
        Row: {
          created_at: string
          file_path: string
          id: string
          kind: string
          name: string
          pages: number | null
          published_date: string | null
          size_bytes: number | null
        }
        Insert: {
          created_at?: string
          file_path: string
          id?: string
          kind?: string
          name: string
          pages?: number | null
          published_date?: string | null
          size_bytes?: number | null
        }
        Update: {
          created_at?: string
          file_path?: string
          id?: string
          kind?: string
          name?: string
          pages?: number | null
          published_date?: string | null
          size_bytes?: number | null
        }
        Relationships: []
      }
      collection_emails: {
        Row: {
          ar_aging_id: string
          automated: boolean
          content: string
          id: string
          sent_at: string
          sent_by: string | null
          status: string
        }
        Insert: {
          ar_aging_id: string
          automated?: boolean
          content: string
          id?: string
          sent_at?: string
          sent_by?: string | null
          status?: string
        }
        Update: {
          ar_aging_id?: string
          automated?: boolean
          content?: string
          id?: string
          sent_at?: string
          sent_by?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "collection_emails_ar_aging_id_fkey"
            columns: ["ar_aging_id"]
            isOneToOne: false
            referencedRelation: "ar_aging"
            referencedColumns: ["id"]
          },
        ]
      }
      damage_reports: {
        Row: {
          created_at: string
          damage_type: string | null
          dealer_id: string | null
          driver_name: string | null
          id: string
          installer_id: string | null
          order_id: string | null
          p21_order_id: string | null
          photos: Json
          resolution: string | null
          route_code: string | null
          samsara_document_id: string | null
          severity: string
          stage: string
          status: string
        }
        Insert: {
          created_at?: string
          damage_type?: string | null
          dealer_id?: string | null
          driver_name?: string | null
          id?: string
          installer_id?: string | null
          order_id?: string | null
          p21_order_id?: string | null
          photos?: Json
          resolution?: string | null
          route_code?: string | null
          samsara_document_id?: string | null
          severity?: string
          stage?: string
          status?: string
        }
        Update: {
          created_at?: string
          damage_type?: string | null
          dealer_id?: string | null
          driver_name?: string | null
          id?: string
          installer_id?: string | null
          order_id?: string | null
          p21_order_id?: string | null
          photos?: Json
          resolution?: string | null
          route_code?: string | null
          samsara_document_id?: string | null
          severity?: string
          stage?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "damage_reports_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      design_quote_lines: {
        Row: {
          created_at: string
          description: string | null
          id: string
          line_no: number | null
          list_price: number | null
          options: Json
          part_number: string | null
          quantity: number | null
          quote_id: string
          room: string | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          line_no?: number | null
          list_price?: number | null
          options?: Json
          part_number?: string | null
          quantity?: number | null
          quote_id: string
          room?: string | null
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          line_no?: number | null
          list_price?: number | null
          options?: Json
          part_number?: string | null
          quantity?: number | null
          quote_id?: string
          room?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "design_quote_lines_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "design_quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      design_quotes: {
        Row: {
          created_at: string
          id: string
          imported_by: string | null
          line_count: number | null
          quote_name: string
          room_count: number | null
          sif_date: string | null
          source_file: string | null
          total_list: number | null
          total_sell: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          imported_by?: string | null
          line_count?: number | null
          quote_name: string
          room_count?: number | null
          sif_date?: string | null
          source_file?: string | null
          total_list?: number | null
          total_sell?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          imported_by?: string | null
          line_count?: number | null
          quote_name?: string
          room_count?: number | null
          sif_date?: string | null
          source_file?: string | null
          total_list?: number | null
          total_sell?: number | null
        }
        Relationships: []
      }
      fleet_loads: {
        Row: {
          capacity_pct: number | null
          created_at: string
          departure_date: string | null
          driver_name: string | null
          id: string
          orders: Json
          route_code: string
          status: string
          total_cubic_ft: number | null
          total_weight: number | null
          truck_id: string | null
        }
        Insert: {
          capacity_pct?: number | null
          created_at?: string
          departure_date?: string | null
          driver_name?: string | null
          id?: string
          orders?: Json
          route_code: string
          status?: string
          total_cubic_ft?: number | null
          total_weight?: number | null
          truck_id?: string | null
        }
        Update: {
          capacity_pct?: number | null
          created_at?: string
          departure_date?: string | null
          driver_name?: string | null
          id?: string
          orders?: Json
          route_code?: string
          status?: string
          total_cubic_ft?: number | null
          total_weight?: number | null
          truck_id?: string | null
        }
        Relationships: []
      }
      fleet_routes: {
        Row: {
          created_at: string
          delivery_day: string | null
          destination_city: string
          driver_name: string | null
          group_label: string | null
          hub: string
          id: string
          raw_row: Json
          route_code: string | null
          schedule_notes: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          delivery_day?: string | null
          destination_city: string
          driver_name?: string | null
          group_label?: string | null
          hub: string
          id?: string
          raw_row?: Json
          route_code?: string | null
          schedule_notes?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          delivery_day?: string | null
          destination_city?: string
          driver_name?: string | null
          group_label?: string | null
          hub?: string
          id?: string
          raw_row?: Json
          route_code?: string | null
          schedule_notes?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      inbound_emails: {
        Row: {
          ai_extracted: Json
          ai_flags: Json
          ai_summary: string | null
          attachments: Json
          body_html: string | null
          body_text: string | null
          classification: string
          confidence: number | null
          created_record_id: string | null
          created_record_type: string | null
          error: string | null
          from_addr: string
          from_name: string | null
          headers: Json
          id: string
          message_id: string | null
          processed_at: string | null
          raw_payload: Json | null
          received_at: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          subject: string | null
          to_addr: string | null
        }
        Insert: {
          ai_extracted?: Json
          ai_flags?: Json
          ai_summary?: string | null
          attachments?: Json
          body_html?: string | null
          body_text?: string | null
          classification?: string
          confidence?: number | null
          created_record_id?: string | null
          created_record_type?: string | null
          error?: string | null
          from_addr: string
          from_name?: string | null
          headers?: Json
          id?: string
          message_id?: string | null
          processed_at?: string | null
          raw_payload?: Json | null
          received_at?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          subject?: string | null
          to_addr?: string | null
        }
        Update: {
          ai_extracted?: Json
          ai_flags?: Json
          ai_summary?: string | null
          attachments?: Json
          body_html?: string | null
          body_text?: string | null
          classification?: string
          confidence?: number | null
          created_record_id?: string | null
          created_record_type?: string | null
          error?: string | null
          from_addr?: string
          from_name?: string | null
          headers?: Json
          id?: string
          message_id?: string | null
          processed_at?: string | null
          raw_payload?: Json | null
          received_at?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          subject?: string | null
          to_addr?: string | null
        }
        Relationships: []
      }
      inventory_snapshots: {
        Row: {
          birm_qty: number | null
          created_at: string
          dallas_qty: number | null
          e2g_price: number | null
          id: string
          is_kit: boolean | null
          item_desc: string | null
          item_id: string
          net_weight: number | null
          next_due_in: string | null
          next_due_in_2: string | null
          ocala_qty: number | null
          snapshot_date: string
          source: string
          total_qty: number | null
          weight: number | null
        }
        Insert: {
          birm_qty?: number | null
          created_at?: string
          dallas_qty?: number | null
          e2g_price?: number | null
          id?: string
          is_kit?: boolean | null
          item_desc?: string | null
          item_id: string
          net_weight?: number | null
          next_due_in?: string | null
          next_due_in_2?: string | null
          ocala_qty?: number | null
          snapshot_date?: string
          source?: string
          total_qty?: number | null
          weight?: number | null
        }
        Update: {
          birm_qty?: number | null
          created_at?: string
          dallas_qty?: number | null
          e2g_price?: number | null
          id?: string
          is_kit?: boolean | null
          item_desc?: string | null
          item_id?: string
          net_weight?: number | null
          next_due_in?: string | null
          next_due_in_2?: string | null
          ocala_qty?: number | null
          snapshot_date?: string
          source?: string
          total_qty?: number | null
          weight?: number | null
        }
        Relationships: []
      }
      order_acknowledgements: {
        Row: {
          content: string
          created_at: string
          id: string
          order_id: string
          sent_at: string | null
          sent_by: string | null
          sent_to: string | null
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          order_id: string
          sent_at?: string | null
          sent_by?: string | null
          sent_to?: string | null
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          order_id?: string
          sent_at?: string | null
          sent_by?: string | null
          sent_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "order_acknowledgements_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          ai_confidence: number | null
          ai_flags: Json
          bill_to: Json | null
          created_at: string
          customer_id: string | null
          customer_name: string
          id: string
          line_items: Json
          p21_order_id: string | null
          p21_submitted_at: string | null
          po_number: string | null
          raw_input: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          ship_to: Json | null
          source: string
          status: string
          updated_at: string
        }
        Insert: {
          ai_confidence?: number | null
          ai_flags?: Json
          bill_to?: Json | null
          created_at?: string
          customer_id?: string | null
          customer_name: string
          id?: string
          line_items?: Json
          p21_order_id?: string | null
          p21_submitted_at?: string | null
          po_number?: string | null
          raw_input?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          ship_to?: Json | null
          source?: string
          status?: string
          updated_at?: string
        }
        Update: {
          ai_confidence?: number | null
          ai_flags?: Json
          bill_to?: Json | null
          created_at?: string
          customer_id?: string | null
          customer_name?: string
          id?: string
          line_items?: Json
          p21_order_id?: string | null
          p21_submitted_at?: string | null
          po_number?: string | null
          raw_input?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          ship_to?: Json | null
          source?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      p21_bridge_agents: {
        Row: {
          created_at: string
          id: string
          ip: string | null
          last_seen_at: string | null
          name: string
          version: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          ip?: string | null
          last_seen_at?: string | null
          name: string
          version?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          ip?: string | null
          last_seen_at?: string | null
          name?: string
          version?: string | null
        }
        Relationships: []
      }
      p21_bridge_jobs: {
        Row: {
          agent_id: string | null
          claimed_at: string | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          error: string | null
          id: string
          kind: string
          payload: Json
          result: Json | null
          status: string
        }
        Insert: {
          agent_id?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          kind: string
          payload?: Json
          result?: Json | null
          status?: string
        }
        Update: {
          agent_id?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          kind?: string
          payload?: Json
          result?: Json | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "p21_bridge_jobs_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "p21_bridge_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      price_list: {
        Row: {
          cat_number: string | null
          category: string | null
          created_at: string
          dealer_cost: number | null
          description: string | null
          effective_date: string | null
          er_cost: number | null
          id: string
          item: string
          list_price: number | null
          mfg: string | null
          source: string | null
          updated_at: string
          weight: number | null
        }
        Insert: {
          cat_number?: string | null
          category?: string | null
          created_at?: string
          dealer_cost?: number | null
          description?: string | null
          effective_date?: string | null
          er_cost?: number | null
          id?: string
          item: string
          list_price?: number | null
          mfg?: string | null
          source?: string | null
          updated_at?: string
          weight?: number | null
        }
        Update: {
          cat_number?: string | null
          category?: string | null
          created_at?: string
          dealer_cost?: number | null
          description?: string | null
          effective_date?: string | null
          er_cost?: number | null
          id?: string
          item?: string
          list_price?: number | null
          mfg?: string | null
          source?: string | null
          updated_at?: string
          weight?: number | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          email: string | null
          id: string
          sales_rep_code: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          id: string
          sales_rep_code?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
          sales_rep_code?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      report_runs: {
        Row: {
          completed_at: string | null
          id: string
          notes: string | null
          output_url: string | null
          recipients_count: number | null
          schedule_id: string | null
          started_at: string
          status: string
        }
        Insert: {
          completed_at?: string | null
          id?: string
          notes?: string | null
          output_url?: string | null
          recipients_count?: number | null
          schedule_id?: string | null
          started_at?: string
          status?: string
        }
        Update: {
          completed_at?: string | null
          id?: string
          notes?: string | null
          output_url?: string | null
          recipients_count?: number | null
          schedule_id?: string | null
          started_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_runs_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "report_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      report_schedules: {
        Row: {
          active: boolean
          audience_roles: Json
          created_at: string
          date_range: string
          filters: Json
          format: string
          id: string
          last_run_at: string | null
          last_status: string | null
          name: string
          recipients: Json
          schedule_cron: string
          template: string | null
          type: string
        }
        Insert: {
          active?: boolean
          audience_roles?: Json
          created_at?: string
          date_range?: string
          filters?: Json
          format?: string
          id?: string
          last_run_at?: string | null
          last_status?: string | null
          name: string
          recipients?: Json
          schedule_cron: string
          template?: string | null
          type: string
        }
        Update: {
          active?: boolean
          audience_roles?: Json
          created_at?: string
          date_range?: string
          filters?: Json
          format?: string
          id?: string
          last_run_at?: string | null
          last_status?: string | null
          name?: string
          recipients?: Json
          schedule_cron?: string
          template?: string | null
          type?: string
        }
        Relationships: []
      }
      sales_cache: {
        Row: {
          cached_at: string
          data: Json
          date_from: string
          date_to: string
          id: string
          period: string
          rep_code: string
        }
        Insert: {
          cached_at?: string
          data: Json
          date_from: string
          date_to: string
          id?: string
          period: string
          rep_code: string
        }
        Update: {
          cached_at?: string
          data?: Json
          date_from?: string
          date_to?: string
          id?: string
          period?: string
          rep_code?: string
        }
        Relationships: []
      }
      sku_crossref: {
        Row: {
          competitor_sku: string
          confidence: number | null
          created_at: string
          id: string
          ndi_sku: string
          source: string
        }
        Insert: {
          competitor_sku: string
          confidence?: number | null
          created_at?: string
          id?: string
          ndi_sku: string
          source?: string
        }
        Update: {
          competitor_sku?: string
          confidence?: number | null
          created_at?: string
          id?: string
          ndi_sku?: string
          source?: string
        }
        Relationships: []
      }
      spiff_calculations: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          created_at: string
          customer_id: string
          customer_name: string
          gross_sales: number
          id: string
          quarter: string
          sales_rep: string | null
          spiff_amount: number
          status: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          customer_id: string
          customer_name: string
          gross_sales?: number
          id?: string
          quarter: string
          sales_rep?: string | null
          spiff_amount?: number
          status?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          customer_id?: string
          customer_name?: string
          gross_sales?: number
          id?: string
          quarter?: string
          sales_rep?: string | null
          spiff_amount?: number
          status?: string
        }
        Relationships: []
      }
      spiff_rules: {
        Row: {
          active: boolean
          created_at: string
          customer_id: string
          customer_name: string
          id: string
          notes: string | null
          rate_type: string
          rate_value: number
          sales_rep_split: boolean
          sku_filter: string | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          customer_id: string
          customer_name: string
          id?: string
          notes?: string | null
          rate_type?: string
          rate_value: number
          sales_rep_split?: boolean
          sku_filter?: string | null
        }
        Update: {
          active?: boolean
          created_at?: string
          customer_id?: string
          customer_name?: string
          id?: string
          notes?: string | null
          rate_type?: string
          rate_value?: number
          sales_rep_split?: boolean
          sku_filter?: string | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_admin_if_none: { Args: never; Returns: boolean }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role:
        | "admin"
        | "ops_orders"
        | "ops_ar"
        | "ops_logistics"
        | "ops_reports"
        | "sales_rep"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: [
        "admin",
        "ops_orders",
        "ops_ar",
        "ops_logistics",
        "ops_reports",
        "sales_rep",
      ],
    },
  },
} as const
