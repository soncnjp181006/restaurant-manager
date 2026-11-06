import { ReactNode, useRef, useState } from "react";
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from "react-router";
import { Button } from "@/components/common/input/button.tsx";
import {
  faArrowLeft,
  faPrint,
  faFile,
  faRefresh,
  faChevronLeft,
  faChevronRight, faImage,
} from "@fortawesome/free-solid-svg-icons";
import { cn } from "@/lib/utils.ts";
import { REPORTS } from "@/routes/restaurant-manager.ts";
import {
  exportElementAsImage,
  exportElementAsPdf,
  printDocument,
} from "@/lib/export.document.ts";
import * as XLSX from "xlsx";
import { DateTime } from "luxon";
import { DocumentTitle } from "@/components/common/document-title.tsx";
import { DATE_TIME_FORMAT } from '@/lib/date-format';

export interface ReportsLayoutProps {
  /** Report title */
  title: string;
  /** Subtitle, typically for date range */
  subtitle?: string;
  /** Restaurant name */
  restaurantName?: string;
  /** Restaurant address */
  restaurantAddress?: string;
  /** Report content */
  children: ReactNode;
  /** Optional pagination props */
  pagination?: {
    currentPage: number;
    totalPages: number;
    onPageChange: (page: number) => void;
  };
  /** Custom action buttons */
  customActions?: ReactNode;
  /** Callback for print action */
  onPrint?: () => void;
  /** Callback for Excel export */
  onExportExcel?: () => void;
  /** Callback for PDF export */
  onExportPdf?: () => void;
  /** Callback for PDF export */
  onExportImage?: () => void;
  /** Callback for refresh action */
  onRefresh?: () => void;
  /** Additional className for the container */
  className?: string;
}

export const ReportsLayout = ({
  title,
  subtitle,
  restaurantName = import.meta.env.VITE_RESTAURANT_NAME,
  restaurantAddress = import.meta.env.VITE_RESTAURANT_ADDRESS,
  children,
  pagination,
  customActions,
  onPrint,
  onExportExcel,
  onExportPdf,
  onExportImage,
  onRefresh,
  className,
}: ReportsLayoutProps) => {
  const { t } = useTranslation('reports');
  const { t: tNav } = useTranslation('navigation');
  const { t: tCommon } = useTranslation('common');
  const navigate = useNavigate();
  const location = useLocation();
  const reportRef = useRef<HTMLDivElement>(null);
  const [generatedAt] = useState(DateTime.now().toFormat(DATE_TIME_FORMAT));

  // Opened from the app → go back in history; opened cold (direct link) → reports index.
  const handleBack = () => {
    if (location.key !== 'default') {
      navigate(-1);
      return;
    }
    navigate(REPORTS);
  };

  const handlePrint = () => {
    if (onPrint) {
      onPrint();
    } else {
      printDocument();
    }
  };

  const handleExportExcel = async () => {
    if (onExportExcel) {
      onExportExcel();
    } else {
      const tables = Array.from(
        reportRef.current?.querySelectorAll("table") ?? [],
      );
      if (tables.length === 0) return;

      const wb = XLSX.utils.book_new();
      let ws: XLSX.WorkSheet | undefined;
      let nextRow = 0;

      tables.forEach((table) => {
        const tableWs = XLSX.utils.table_to_sheet(table);

        if (!ws) {
          ws = tableWs;
          const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
          nextRow = range.e.r + 2;
          return;
        }

        ws = appendWorksheetAtRow(ws, tableWs, nextRow);
        const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
        nextRow = range.e.r + 2;
      });

      XLSX.utils.book_append_sheet(wb, ws!, "Report");
      XLSX.writeFile(wb, "report.xlsx");
    }
  };

  const handleExportPdf = async () => {
    if (onExportPdf) {
      onExportPdf();
    } else {
      await exportElementAsPdf(reportRef.current, "report.pdf");
    }
  };

  const handleExportImage = async () => {
    if (onExportImage) {
      onExportImage();
    } else {
      await exportElementAsImage(reportRef.current, "report.png");
    }
  };

  const handleRefresh = () => {
    if (onRefresh) {
      onRefresh();
    } else {
      // Default: Reload the page
      window.location.reload();
    }
  };

  return (
    <div className={cn("flex flex-col h-full", className)}>
      <DocumentTitle parts={[title, tNav('sidebar.reports')]} />
      {/* Action Buttons */}
      <div className="flex items-center justify-between gap-3 p-4 bg-surface-elevated shadow-sm border-b print:hidden">
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            onClick={handleBack}
            icon={faArrowLeft}
            size="sm"
          >
            {tCommon('actions.back')}
          </Button>
          <Button
            variant="primary"
            onClick={handlePrint}
            icon={faPrint}
            size="sm"
          >
            {t('labels.print')}
          </Button>
          <Button
            variant="primary"
            onClick={handleExportExcel}
            icon={faFile}
            size="sm"
          >
            {t('labels.downloadXlsx')}
          </Button>
          <Button
            variant="primary"
            onClick={handleExportPdf}
            icon={faFile}
            size="sm"
          >
            {t('labels.downloadPdf')}
          </Button>
          <Button
            variant="primary"
            onClick={handleExportImage}
            icon={faImage}
            size="sm"
          >
            {t('labels.downloadImage')}
          </Button>
          <Button
            variant="primary"
            onClick={handleRefresh}
            icon={faRefresh}
            size="sm"
          >
            {t('labels.refresh')}
          </Button>
          {customActions}
        </div>
      </div>

      {/* Report Container */}
      <div className="flex-1 overflow-auto bg-surface" ref={reportRef}>
        <div className="max-w-full">
          {/* Header Section */}
          <div className="bg-surface-elevated shadow-sm rounded-lg p-3 mb-3 print:shadow-none text-center">
            <h1 className="text-3xl font-bold mb-1">{title}</h1>
            {subtitle && (
              <p className="text-lg text-muted mb-1">{subtitle}</p>
            )}
            <div className="space-y-[3px] text-sm text-foreground">
              {restaurantName && (
                <p className="font-semibold">{restaurantName}</p>
              )}
              {restaurantAddress && <p>{restaurantAddress}</p>}
              <p className="text-muted mt-2">
                {t('labels.generatedAt', { time: generatedAt })}
              </p>
            </div>
          </div>

          {/* Report Content */}
          <div className="bg-surface-elevated shadow-sm rounded-lg p-6 print:shadow-none">
            {children}
          </div>

          {/* Pagination */}
          {pagination && pagination.totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-6 bg-surface-elevated shadow-sm rounded-lg p-4">
              <Button
                variant="primary"
                onClick={() => pagination.onPageChange(pagination.currentPage - 1)}
                disabled={pagination.currentPage === 1}
                icon={faChevronLeft}
                size="sm"
              >
                {t('labels.previous')}
              </Button>
              <span className="text-sm text-foreground px-4">
                Page {pagination.currentPage} of {pagination.totalPages}
              </span>
              <Button
                variant="primary"
                onClick={() => pagination.onPageChange(pagination.currentPage + 1)}
                disabled={pagination.currentPage === pagination.totalPages}
                rightIcon={faChevronRight}
                size="sm"
              >
                {t('labels.next')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

function appendWorksheetAtRow(
  target: XLSX.WorkSheet,
  source: XLSX.WorkSheet,
  startRow: number,
): XLSX.WorkSheet {
  const sourceRange = XLSX.utils.decode_range(source["!ref"] ?? "A1");
  const targetRange = XLSX.utils.decode_range(target["!ref"] ?? "A1");

  for (let row = sourceRange.s.r; row <= sourceRange.e.r; row++) {
    for (let col = sourceRange.s.c; col <= sourceRange.e.c; col++) {
      const sourceAddress = XLSX.utils.encode_cell({ r: row, c: col });
      const cell = source[sourceAddress];
      if (!cell) continue;

      const destAddress = XLSX.utils.encode_cell({
        r: startRow + (row - sourceRange.s.r),
        c: col,
      });
      target[destAddress] = { ...cell };
    }
  }

  const endRow = startRow + (sourceRange.e.r - sourceRange.s.r);
  target["!ref"] = XLSX.utils.encode_range({
    s: targetRange.s,
    e: {
      r: Math.max(targetRange.e.r, endRow),
      c: Math.max(targetRange.e.c, sourceRange.e.c),
    },
  });

  return target;
}

// Helper function to convert table to CSV
function tableToCSV(table: HTMLTableElement): string {
  const rows: string[] = [];
  const trs = table.querySelectorAll("tr");

  trs.forEach((tr) => {
    const cells: string[] = [];
    const tds = tr.querySelectorAll("td, th");

    tds.forEach((td) => {
      let text = td.textContent || "";
      // Escape quotes and wrap in quotes if contains comma or quote
      if (text.includes(",") || text.includes('"') || text.includes("\n")) {
        text = `"${text.replace(/"/g, '""')}"`;
      }
      cells.push(text);
    });

    rows.push(cells.join(","));
  });

  return rows.join("\n");
}

// Helper function to download CSV
function downloadCSV(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);

  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}